<script setup lang="ts">
/**
 * 关闭主窗口确认弹窗。
 *
 * 触发：主进程 'close' 拦截 → onRequestClose → useSettingsStore.handleClose
 *       （仅 remindOnClose=true 时打开本弹窗）。
 *
 * 交互：
 *   - 单选：最小化到托盘（推荐，默认选中当前 closeAction）/ 退出应用
 *   - 复选「不再提醒（记住选择）」：勾选后写 remindOnClose=false + 所选 closeAction
 *   - 确定 → 按所选执行（隐藏到托盘 / 退出）
 *   - 取消 → 仅关闭弹窗，窗口保持原状（不退出也不隐藏）
 *
 * 弹窗打开时从 useSettingsStore 读取默认 closeAction 作为初始选择。
 */
import { ref, watch } from 'vue'
import { NModal, NRadioGroup, NRadio, NCheckbox, NButton, NSpace, NText } from 'naive-ui'
import type { CloseAction } from '@shared/index'
import { useSettingsStore } from '@/stores/useSettingsStore'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [v: boolean] }>()

const settings = useSettingsStore()

const action = ref<CloseAction>('tray')
const remember = ref(false)

// 每次打开：用持久化的 closeAction 作为默认选中
watch(
  () => props.show,
  (open) => {
    if (open) {
      action.value = settings.settings?.closeAction ?? 'tray'
      remember.value = false
    }
  }
)

function onConfirm(): void {
  const a = action.value
  emit('update:show', false)
  if (remember.value) {
    // 记住选择：写设置 + 立即执行
    void settings.setRememberedAndClose(a)
  } else {
    settings.executeClose(a)
  }
}

function onCancel(): void {
  emit('update:show', false)
}
</script>

<template>
  <NModal
    :show="props.show"
    preset="card"
    title="关闭窗口"
    style="width: 380px; max-width: 92vw"
    :bordered="false"
    :mask-closable="false"
    :close-on-esc="true"
    @update:show="(v) => emit('update:show', v)"
  >
    <div class="cc">
      <NText class="cc__desc">选择关闭主窗口时的操作</NText>

      <NRadioGroup v-model:value="action" name="closeAction" class="cc__group">
        <div class="cc__opt">
          <NRadio value="tray">
            <span class="cc__opt-label">最小化到托盘</span>
            <NText depth="3" class="cc__opt-hint">保留在后台，从托盘图标恢复</NText>
          </NRadio>
        </div>
        <div class="cc__opt">
          <NRadio value="quit">
            <span class="cc__opt-label">退出应用</span>
            <NText depth="3" class="cc__opt-hint">完全关闭程序</NText>
          </NRadio>
        </div>
      </NRadioGroup>

      <NCheckbox v-model:checked="remember" class="cc__remember">
        <span class="cc__remember-text">不再提醒（记住选择）</span>
      </NCheckbox>
    </div>

    <template #footer>
      <NSpace justify="end" :size="8">
        <NButton size="small" @click="onCancel">取消</NButton>
        <NButton size="small" type="primary" @click="onConfirm">确定</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.cc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.cc__desc {
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}
.cc__group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.cc__opt :deep(.n-radio) {
  align-items: flex-start;
}
.cc__opt-label {
  font-size: var(--fs-sm);
  color: var(--text-primary);
  font-weight: 500;
}
.cc__opt-hint {
  display: block;
  font-size: var(--fs-xs);
  margin-top: 2px;
}
.cc__remember {
  margin-top: var(--sp-1);
}
.cc__remember-text {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
}
</style>
