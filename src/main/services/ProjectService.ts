/**
 * 项目管理服务
 * 负责项目列表的增删查；添加时校验是否 git 仓库。
 * 持久化交给 StoreService。
 */
import path from 'path'
import crypto from 'crypto'
import type { ProjectMeta } from '@shared/index'
import { StoreService } from './StoreService'
import { checkIsRepo, dirName } from './GitService'

export class ProjectError extends Error {
  constructor(public code: 'not_repo' | 'exists' | 'invalid_path', message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/** 基于路径生成稳定 id（同路径 id 相同，避免重复添加） */
function idOf(p: string): string {
  return crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 12)
}

export const ProjectService = {
  list(): ProjectMeta[] {
    return StoreService.getProjects()
  },

  /** 添加项目：校验目录 + 校验 git + 去重 */
  async add(rawPath: string): Promise<ProjectMeta> {
    const repoPath = path.resolve(rawPath.trim())
    if (!repoPath || repoPath.length < 2) {
      throw new ProjectError('invalid_path', '路径不合法')
    }
    const exists = await checkIsRepo(repoPath)
    if (!exists) {
      throw new ProjectError('not_repo', '该目录不是 Git 仓库')
    }

    const projects = StoreService.getProjects()
    const id = idOf(repoPath)
    if (projects.some((p) => p.id === id)) {
      throw new ProjectError('exists', '该项目已在列表中')
    }

    const meta: ProjectMeta = {
      id,
      name: dirName(repoPath),
      path: repoPath,
      createdAt: Date.now()
    }
    StoreService.setProjects([...projects, meta])
    return meta
  },

  /** 从列表移除（不碰磁盘） */
  remove(id: string): void {
    const projects = StoreService.getProjects().filter((p) => p.id !== id)
    StoreService.setProjects(projects)
  },

  /** 重命名（仅应用内显示名） */
  rename(id: string, name: string): ProjectMeta | null {
    const projects = StoreService.getProjects()
    const idx = projects.findIndex((p) => p.id === id)
    if (idx < 0) return null
    projects[idx] = { ...projects[idx], name: name.trim() || projects[idx].name }
    StoreService.setProjects(projects)
    return projects[idx]
  },

  /** 校验某个已存项目路径是否仍有效（防止目录被删/移动） */
  async validate(id: string): Promise<{ ok: boolean; isRepo: boolean }> {
    const projects = StoreService.getProjects()
    const p = projects.find((x) => x.id === id)
    if (!p) return { ok: false, isRepo: false }
    return { ok: true, isRepo: await checkIsRepo(p.path) }
  }
}
