/**
 * UI store：视图切换、侧栏折叠、设置弹窗等纯 UI 状态。
 * 按 AGENTS.md 约定，不使用 vue-router，用 activeView 控制视图。
 *
 * 侧栏折叠状态（siderCollapsed）会持久化到 electron-store：
 * - initSiderCollapsed()：启动时从持久层恢复，记忆上次状态
 * - watch siderCollapsed：每次变化写回，保证下次进入一致
 */
import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export type ViewName = 'workspace' | 'tokens'

export const useUiStore = defineStore('ui', () => {
  const activeView = ref<ViewName>('workspace')
  const siderCollapsed = ref(false)
  const settingsOpen = ref(false)

  function setView(v: ViewName): void {
    activeView.value = v
  }
  function toggleSider(): void {
    siderCollapsed.value = !siderCollapsed.value
  }

  /** 启动时从持久层恢复侧栏折叠状态（记忆上次）。仅在应用初始化时调用一次。 */
  async function initSiderCollapsed(): Promise<void> {
    siderCollapsed.value = await window.api.getSiderCollapsed()
  }

  // 每次折叠状态变化都写回持久层，保证下次进入一致
  watch(siderCollapsed, (collapsed) => {
    void window.api.setSiderCollapsed(collapsed)
  })

  return { activeView, siderCollapsed, settingsOpen, setView, toggleSider, initSiderCollapsed }
})
