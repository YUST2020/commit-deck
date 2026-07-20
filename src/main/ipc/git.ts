/**
 * Git 相关 IPC handler
 * 入参统一为 (projectPath, ...rest)，校验路径合法性后委托给 GitService。
 */
import path from 'path'
import { ipcMain } from 'electron'
import {
  getBranch,
  getDiffFile,
  getDiffStaged,
  getLog,
  getStatus,
  resetFiles,
  addFiles,
  checkIsRepo,
  fetch as gitFetchFn,
  commit as gitCommitFn,
  push as gitPushFn,
  pull as gitPullFn,
  undoCommit as gitUndoCommitFn,
  listChangedFilesForReview
} from '../services/GitService'
import { aggregateDiffForAi } from '../services/DiffAggregator'

/** 校验路径必须是绝对路径且确实存在，防止渲染进程传相对路径越权 */
function assertValidPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) {
    throw new Error('非法的项目路径')
  }
}

type Guarded<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

function guard<T>(fn: () => Promise<T> | T): Promise<Guarded<T>> {
  return Promise.resolve()
    .then(fn)
    .then((data): Guarded<T> => ({ ok: true, data }))
    .catch((e: unknown): Guarded<T> => ({
      ok: false,
      error: { message: e instanceof Error ? e.message : 'git 操作失败' }
    }))
}

export function registerGitIpc(): void {
  ipcMain.handle('git:checkRepo', async (_e, repoPath: unknown) => {
    try {
      assertValidPath(repoPath)
      return await checkIsRepo(repoPath)
    } catch {
      return false
    }
  })

  ipcMain.handle('git:status', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => getStatus(repoPath))
  })

  ipcMain.handle('git:log', async (_e, repoPath: unknown, maxCount?: unknown) => {
    assertValidPath(repoPath)
    return guard(() => getLog(repoPath, typeof maxCount === 'number' ? maxCount : 50))
  })

  ipcMain.handle('git:branch', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => getBranch(repoPath))
  })

  ipcMain.handle('git:diffFile', async (_e, repoPath: unknown, file: unknown, staged: unknown) => {
    assertValidPath(repoPath)
    // file 可为单路径字符串（普通文件）或路径数组（rename 需新旧两路径一起传）
    if (typeof file !== 'string' && !Array.isArray(file)) throw new Error('文件路径非法')
    const normalized = Array.isArray(file)
      ? file.filter((p): p is string => typeof p === 'string')
      : file
    return guard(() => getDiffFile(repoPath, normalized, Boolean(staged)))
  })

  ipcMain.handle('git:diffStaged', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => getDiffStaged(repoPath))
  })

  ipcMain.handle('git:add', async (_e, repoPath: unknown, files: unknown) => {
    assertValidPath(repoPath)
    if (!Array.isArray(files)) throw new Error('文件列表非法')
    return guard(() => addFiles(repoPath, files as string[]))
  })

  ipcMain.handle('git:reset', async (_e, repoPath: unknown, files: unknown) => {
    assertValidPath(repoPath)
    if (!Array.isArray(files)) throw new Error('文件列表非法')
    return guard(() => resetFiles(repoPath, files as string[]))
  })

  ipcMain.handle('git:fetch', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => gitFetchFn(repoPath))
  })

  ipcMain.handle('git:commit', async (_e, repoPath: unknown, message: unknown) => {
    assertValidPath(repoPath)
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('提交信息为空')
    }
    return guard(() => gitCommitFn(repoPath, message))
  })

  ipcMain.handle('git:push', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => gitPushFn(repoPath))
  })

  // 拉取远端（git pull --rebase）；冲突时主进程自动 abort 回退
  ipcMain.handle('git:pull', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => gitPullFn(repoPath))
  })

  ipcMain.handle('git:diffForAi', async (_e, repoPath: unknown, model?: unknown, forceIncludePaths?: unknown, onlyPaths?: unknown) => {
    assertValidPath(repoPath)
    const m = typeof model === 'string' ? model : undefined
    // forceIncludePaths 必须是字符串数组（可为空）；渲染进程可能传 ref/array，这里校验后转纯数组
    const force = Array.isArray(forceIncludePaths)
      ? forceIncludePaths.filter((p): p is string => typeof p === 'string')
      : []
    // onlyPaths：代码审查文件选择器选中的路径白名单（可为空=不过滤）；同样校验为纯字符串数组
    const only = Array.isArray(onlyPaths)
      ? onlyPaths.filter((p): p is string => typeof p === 'string')
      : []
    return guard(() => aggregateDiffForAi(repoPath, m, force, only))
  })

  // 代码审查文件选择器取数：列出可审查的改动文件（含 contentOmitted 标记）
  ipcMain.handle('git:changedFiles', async (_e, repoPath: unknown) => {
    assertValidPath(repoPath)
    return guard(() => listChangedFilesForReview(repoPath))
  })

  ipcMain.handle('git:undoCommit', async (_e, repoPath: unknown, count: unknown) => {
    assertValidPath(repoPath)
    const n = typeof count === 'number' ? count : 1
    return guard(() => gitUndoCommitFn(repoPath, n))
  })
}
