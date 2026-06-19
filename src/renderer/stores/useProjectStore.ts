/**
 * 项目 store：项目列表 + 当前选中 + 增删改
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ProjectMeta } from '@shared/index'

type ErrCode = 'not_repo' | 'exists' | 'invalid_path' | 'unknown'
const ERR_TEXT: Record<ErrCode, string> = {
  not_repo: '该目录不是 Git 仓库',
  exists: '该项目已在列表中',
  invalid_path: '路径不合法',
  unknown: '添加失败'
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<ProjectMeta[]>([])
  const activeId = ref<string | null>(null)
  const loading = ref(false)

  const active = computed(() =>
    projects.value.find((p) => p.id === activeId.value) ?? null
  )

  /** 从持久化加载 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      projects.value = await window.api.listProjects()
      // 自动选中第一个（如有）
      if (!activeId.value && projects.value.length) {
        activeId.value = projects.value[0].id
      }
    } finally {
      loading.value = false
    }
  }

  /** 弹目录选择框并添加 */
  async function addByDialog(): Promise<{ ok: boolean; message?: string; data?: ProjectMeta }> {
    const dir = await window.api.pickDirectory()
    if (!dir) return { ok: false } // 用户取消
    const res = await window.api.addProject(dir)
    if (res.ok) {
      projects.value.push(res.data)
      activeId.value = res.data.id
      return { ok: true, data: res.data }
    }
    return {
      ok: false,
      message: ERR_TEXT[(res.error.code as ErrCode) ?? 'unknown'] ?? res.error.message
    }
  }

  async function remove(id: string): Promise<void> {
    const res = await window.api.removeProject(id)
    if (!res.ok) return
    projects.value = projects.value.filter((p) => p.id !== id)
    if (activeId.value === id) {
      activeId.value = projects.value[0]?.id ?? null
    }
  }

  async function rename(id: string, name: string): Promise<void> {
    const res = await window.api.renameProject(id, name)
    if (!res.ok) return
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx >= 0) projects.value[idx] = res.data
  }

  function select(id: string): void {
    activeId.value = id
  }

  return { projects, activeId, active, loading, load, addByDialog, remove, rename, select }
})
