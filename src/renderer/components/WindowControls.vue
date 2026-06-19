<script setup lang="ts">
/**
 * 自定义窗口控件（最小化 / 关闭）。
 * 配合主进程 frame: false，替代系统默认标题栏按钮。
 * 仅做最小化与关闭（应用未提供最大化），按钮放在顶部主题切换按钮右侧。
 */
import { NTooltip } from 'naive-ui'
import { Minus, X } from 'lucide-vue-next'

function onMinimize(): void {
  window.api.windowMinimize()
}
function onClose(): void {
  window.api.windowClose()
}
</script>

<template>
  <div class="win-controls">
    <NTooltip placement="bottom" :delay="300">
      <template #trigger>
        <button class="win-controls__btn" aria-label="最小化" @click="onMinimize">
          <Minus :size="15" />
        </button>
      </template>
      最小化
    </NTooltip>
    <NTooltip placement="bottom" :delay="300">
      <template #trigger>
        <button
          class="win-controls__btn win-controls__btn--close"
          aria-label="关闭"
          @click="onClose"
        >
          <X :size="15" />
        </button>
      </template>
      关闭
    </NTooltip>
  </div>
</template>

<style scoped>
.win-controls {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  /* 防止拖拽区把按钮吞掉：控件自身取消 app-region */
  -webkit-app-region: no-drag;
  app-region: no-drag;
  flex-shrink: 0;
}

.win-controls__btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--r-md);
  color: var(--text-secondary);
  transition: background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.win-controls__btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 关闭按钮 hover 用错误色（与 macOS / VSCode 习惯一致），但保持克制 */
.win-controls__btn--close:hover {
  background: var(--intent-error);
  color: #ffffff;
}
</style>
