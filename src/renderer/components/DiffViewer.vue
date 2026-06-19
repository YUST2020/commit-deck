<script setup lang="ts">
import { computed } from 'vue'
import { NSpin } from 'naive-ui'
import { FileText, GitCompareArrows } from 'lucide-vue-next'

const props = defineProps<{
  file: string
  diff: string
  loading?: boolean
}>()

interface DiffLine {
  type: 'context' | 'add' | 'del' | 'hunk' | 'meta'
  oldNo?: number | string
  newNo?: number | string
  text: string
}

/** 解析 unified diff 文本为行结构 */
function parseDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const lines = diff.split('\n')
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      // hunk 头：@@ -a,b +c,d @@
      const m = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (m) {
        oldNo = parseInt(m[1], 10)
        newNo = parseInt(m[2], 10)
      }
      out.push({ type: 'hunk', text: line })
    } else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('Binary ')) {
      out.push({ type: 'meta', text: line })
    } else if (line.startsWith('+')) {
      out.push({ type: 'add', newNo: newNo++, text: line.slice(1) })
    } else if (line.startsWith('-')) {
      out.push({ type: 'del', oldNo: oldNo++, text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      out.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
    } else if (line === '') {
      // 空行作为上下文
      out.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: '' })
    }
  }
  return out
}

const SEP = /[\\/]/
const fileName = computed(() => {
  const parts = props.file.split(SEP)
  return parts[parts.length - 1] || props.file
})
const dirName = computed(() => {
  if (!props.file) return ''
  const parts = props.file.split(SEP)
  parts.pop()
  return parts.join('/')
})

const lines = computed(() => parseDiff(props.diff))
const stats = computed(() => {
  let add = 0
  let del = 0
  for (const l of lines.value) {
    if (l.type === 'add') add++
    else if (l.type === 'del') del++
  }
  return { add, del }
})
</script>

<template>
  <div class="diff">
    <div class="diff__head">
      <div v-if="fileName" class="diff__file">
        <FileText :size="16" class="diff__file-icon" />
        <div class="diff__file-info">
          <div class="diff__file-name">{{ fileName }}</div>
          <div v-if="dirName" class="diff__file-dir">{{ dirName }}</div>
        </div>
      </div>

      <div v-if="file" class="diff__stats">
        <span class="diff__add">+{{ stats.add }}</span>
        <span class="diff__del">-{{ stats.del }}</span>
      </div>
    </div>

    <div class="diff__body">
      <!-- 未选文件：引导占位 -->
      <div v-if="!file" class="diff__placeholder">
        <div class="diff__ph-icon"><GitCompareArrows :size="28" /></div>
        <div class="diff__ph-title">查看文件差异</div>
        <div class="diff__ph-desc">从左侧选择一个文件，查看其改动内容</div>
      </div>

      <!-- 加载中 -->
      <div v-else-if="loading" class="diff__loading">
        <NSpin size="small" />
      </div>

      <!-- 无差异 -->
      <div v-else-if="!lines.length" class="diff__placeholder">
        <div class="diff__ph-icon diff__ph-icon--muted"><FileText :size="28" /></div>
        <div class="diff__ph-title">没有差异内容</div>
        <div class="diff__ph-desc">该文件当前没有可显示的改动</div>
      </div>

      <!-- diff 内容：key 随文件变化，触发切换淡入动画 -->
      <div v-else :key="file" class="diff__code">
        <div
          v-for="(line, i) in lines"
          :key="i"
          class="line"
          :class="`line--${line.type}`"
        >
          <span class="line__no">{{ line.oldNo ?? '' }}</span>
          <span class="line__no">{{ line.newNo ?? '' }}</span>
          <span class="line__sign">
            {{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : '' }}
          </span>
          <span class="line__text">{{ line.text || ' ' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff {
  height: 100%;
  display: flex;
  flex-direction: column;
  /* 白底卡片：浮起于灰色画布之上，圆角裁剪内部内容 */
  background: var(--bg-panel);
  border-radius: var(--r-lg);
  overflow: hidden;
  min-width: 0;
}

.diff__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  /* 卡片内头部与正文同色（透明），仅靠字重区分标题，不画分隔线 */
}

.diff__file {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.diff__file-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.diff__file-info {
  min-width: 0;
}

.diff__file-name {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff__file-dir {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff__stats {
  display: flex;
  gap: var(--sp-2);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
  font-weight: 600;
  flex-shrink: 0;
}

.diff__add { color: var(--git-added); }
.diff__del { color: var(--git-deleted); }

.diff__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.diff__loading {
  height: 100%;
  display: grid;
  place-items: center;
}

/* 空态占位卡片 */
.diff__placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--sp-2);
  padding: var(--sp-8);
  animation: diff-in var(--dur-slow) var(--ease-standard);
}

.diff__ph-icon {
  width: 56px;
  height: 56px;
  border-radius: var(--r-xl);
  display: grid;
  place-items: center;
  color: var(--brand);
  background: var(--bg-selected);
  margin-bottom: var(--sp-1);
}

.diff__ph-icon--muted {
  color: var(--text-tertiary);
  background: var(--bg-hover);
}

.diff__ph-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.diff__ph-desc {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  max-width: 240px;
  line-height: 1.6;
}

.diff__code {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: 1.65;
  min-width: max-content;
  animation: diff-in var(--dur-slow) var(--ease-standard);
}

@keyframes diff-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.line {
  display: flex;
  align-items: baseline;
  padding-right: var(--sp-4);
}

.line__no {
  width: 42px;
  text-align: right;
  padding: 0 var(--sp-2);
  color: var(--text-tertiary);
  user-select: none;
  flex-shrink: 0;
  opacity: 0.55;
}

.line__sign {
  width: 18px;
  text-align: center;
  flex-shrink: 0;
  font-weight: 700;
}

.line__text {
  white-space: pre;
  flex: 1;
}

.line--context { color: var(--text-primary); }

.line--add { background: color-mix(in srgb, var(--git-added) 12%, transparent); }
.line--add .line__sign,
.line--add .line__text { color: var(--git-added); }

.line--del { background: color-mix(in srgb, var(--git-deleted) 12%, transparent); }
.line--del .line__sign,
.line--del .line__text { color: var(--git-deleted); }

.line--hunk {
  color: var(--intent-info);
  background: var(--bg-hover);
  font-weight: 600;
  padding-top: var(--sp-2);
  padding-bottom: var(--sp-2);
  margin-top: var(--sp-1);
}

.line--meta {
  color: var(--text-tertiary);
  padding-top: var(--sp-1);
  padding-bottom: var(--sp-1);
}
</style>
