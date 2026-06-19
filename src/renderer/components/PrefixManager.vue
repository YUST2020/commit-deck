<script setup lang="ts">
/**
 * 前缀管理弹窗（卡片内"管理"按钮触发）。
 * 支持增删 + 上移/下移排序。保存时一次性 emit('save', list)。
 */
import { ref, watch } from 'vue'
import { NModal, NInput, NButton, NSpace, useMessage } from 'naive-ui'
import { Plus, Trash2, ChevronUp, ChevronDown, ListPlus } from 'lucide-vue-next'
import type { CommitPrefix } from '@shared/index'
import { genPrefixIdLocal } from '@/ai/prefixId'

const props = defineProps<{ show: boolean; prefixes: CommitPrefix[] }>()
const emit = defineEmits<{
  'update:show': [v: boolean]
  save: [prefixes: CommitPrefix[]]
}>()

const message = useMessage()

const list = ref<CommitPrefix[]>([])
const inputLabel = ref('')

watch(
  () => props.show,
  (open) => {
    if (open) {
      list.value = props.prefixes.map((p) => ({ ...p }))
      inputLabel.value = ''
    }
  }
)

function add(): void {
  const label = inputLabel.value.trim()
  if (!label) return
  if (list.value.some((p) => p.label.toLowerCase() === label.toLowerCase())) {
    message.warning('该前缀已存在')
    return
  }
  list.value.push({ id: genPrefixIdLocal(), label })
  inputLabel.value = ''
}

function remove(id: string): void {
  list.value = list.value.filter((p) => p.id !== id)
}

function move(index: number, dir: -1 | 1): void {
  const target = index + dir
  if (target < 0 || target >= list.value.length) return
  const arr = list.value
  const tmp = arr[index]
  arr[index] = arr[target]
  arr[target] = tmp
}

function onCancel(): void {
  emit('update:show', false)
}

function onSave(): void {
  emit('save', list.value)
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    title="管理前缀"
    style="width: 380px; max-width: 92vw"
    :bordered="false"
    :body-style="{ padding: 0 }"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="pm">
      <!-- 新增 -->
      <div class="pm__add">
        <NInput
          v-model:value="inputLabel"
          placeholder="输入前缀，如 feat / TASK#12345"
          size="small"
          @keydown.enter="add"
        />
        <NButton size="small" type="primary" :disabled="!inputLabel.trim()" @click="add">
          <template #icon><Plus :size="14" /></template>
        </NButton>
      </div>

      <!-- 列表 -->
      <div class="pm__list">
        <div v-if="!list.length" class="pm__empty">
          <ListPlus :size="32" class="pm__empty-icon" />
          <div class="pm__empty-text">暂无前缀，添加一个吧</div>
        </div>
        <div
          v-for="(p, i) in list"
          :key="p.id"
          class="pm__row"
        >
          <span class="pm__label">{{ p.label }}</span>
          <div class="pm__ops">
            <button class="pm__op" title="上移" :disabled="i === 0" @click="move(i, -1)">
              <ChevronUp :size="14" />
            </button>
            <button
              class="pm__op"
              title="下移"
              :disabled="i === list.length - 1"
              @click="move(i, 1)"
            >
              <ChevronDown :size="14" />
            </button>
            <button class="pm__op pm__op--del" title="删除" @click="remove(p.id)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton size="small" @click="onCancel">取消</NButton>
        <NButton size="small" type="primary" @click="onSave">保存</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.pm__add {
  display: flex;
  gap: var(--sp-2);
  padding: 0 var(--sp-6) var(--sp-3);
}
.pm__list {
  max-height: 320px;
  overflow: auto;
  padding: 0 var(--sp-6) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.pm__empty {
  padding: var(--sp-8) 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  color: var(--text-tertiary);
  animation: fade-in var(--dur-slow) var(--ease-standard) both;
}
.pm__empty-icon {
  opacity: 0.5;
}
.pm__empty-text {
  font-size: var(--fs-xs);
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.pm__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-md);
  transition: background var(--dur-fast) var(--ease-standard);
}
.pm__row:hover {
  background: var(--bg-hover);
}
.pm__label {
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  color: var(--text-primary);
}
.pm__ops {
  display: flex;
  gap: 2px;
}
.pm__op {
  color: var(--text-tertiary);
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--r-sm);
  transition: color var(--dur-fast), background var(--dur-fast);
}
.pm__op:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-app);
}
.pm__op:disabled {
  opacity: 0.3;
  cursor: default;
}
.pm__op--del:hover {
  color: var(--intent-error);
}
</style>
