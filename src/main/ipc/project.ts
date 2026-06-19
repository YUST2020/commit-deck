/**
 * 项目相关 IPC handler
 */
import { ipcMain, dialog, BrowserWindow } from 'electron'
import type { ProjectMeta } from '@shared/index'
import { ProjectService, ProjectError } from '../services/ProjectService'

/**
 * 取主窗口：优先首个窗口，其次聚焦窗口，都没有则 null（独立弹窗）。
 * 不反向 import index.ts，避免循环依赖。
 */
function getMainWindow(): BrowserWindow | null {
  const all = BrowserWindow.getAllWindows()
  return all[0] ?? BrowserWindow.getFocusedWindow() ?? null
}

/** 打开系统目录选择对话框，返回选中路径或 null */
export async function pickDirectory(): Promise<string | null> {
  const win = getMainWindow()
  const opts: Electron.OpenDialogOptions = {
    title: '选择项目文件夹',
    properties: ['openDirectory']
  }
  // 有父窗口则附加（模态），否则独立弹出
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
}

/** 统一把业务异常转成可序列化的错误对象（IPC 不能直接传 Error） */
function toErr(e: unknown): { code: string; message: string } {
  if (e instanceof ProjectError) return { code: e.code, message: e.message }
  if (e instanceof Error) return { code: 'unknown', message: e.message }
  return { code: 'unknown', message: '未知错误' }
}

export function registerProjectIpc(): void {
  ipcMain.handle('project:pickDirectory', async () => pickDirectory())

  ipcMain.handle('project:list', () => ProjectService.list())

  ipcMain.handle('project:add', async (_e, rawPath: unknown) => {
    try {
      if (typeof rawPath !== 'string' || !rawPath) {
        throw new ProjectError('invalid_path', '路径为空')
      }
      return { ok: true as const, data: await ProjectService.add(rawPath) }
    } catch (e) {
      return { ok: false as const, error: toErr(e) }
    }
  })

  ipcMain.handle('project:remove', (_e, id: unknown) => {
    try {
      if (typeof id !== 'string') throw new ProjectError('invalid_path', 'id 非法')
      ProjectService.remove(id)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: toErr(e) }
    }
  })

  ipcMain.handle(
    'project:rename',
    (_e, id: unknown, name: unknown): { ok: true; data: ProjectMeta } | { ok: false; error: { code: string; message: string } } => {
      try {
        if (typeof id !== 'string' || typeof name !== 'string') {
          throw new ProjectError('invalid_path', '参数非法')
        }
        const data = ProjectService.rename(id, name)
        if (!data) throw new ProjectError('invalid_path', '项目不存在')
        return { ok: true, data }
      } catch (e) {
        return { ok: false, error: toErr(e) }
      }
    }
  )

  ipcMain.handle('project:validate', async (_e, id: unknown) => {
    if (typeof id !== 'string') return { ok: false, isRepo: false }
    return await ProjectService.validate(id)
  })
}
