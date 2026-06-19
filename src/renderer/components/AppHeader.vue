<script setup lang="ts">
import { computed } from 'vue'
import { NText } from 'naive-ui'
import { Package } from 'lucide-vue-next'
import { useProjectStore } from '@/stores/useProjectStore'

const project = useProjectStore()

const projectName = computed(() => project.active?.name ?? '未选择项目')
</script>

<template>
  <div class="header">
    <div class="header__title">
      <Package :size="16" class="header__cube" />
      <span class="header__project">{{ projectName }}</span>
      <NText depth="3" class="header__sep">/</NText>
      <span class="header__view">工作台</span>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: 1;
  min-width: 0;
}

.header__title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-md);
  min-width: 0;
}

.header__cube {
  color: var(--brand);
  flex-shrink: 0;
}

.header__project {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header__sep {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.header__view {
  color: var(--text-secondary);
  white-space: nowrap;
}

.header__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: auto;
}

.header__settings {
  color: var(--text-tertiary);
  cursor: pointer;
  padding: var(--sp-1);
  border-radius: var(--r-sm);
  transition: color var(--dur-fast), background var(--dur-fast);
  flex-shrink: 0;
}

.header__settings:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
</style>
