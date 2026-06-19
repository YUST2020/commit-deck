/**
 * 偏好设置相关 IPC handler
 * —— UI 偏好（侧栏折叠状态等）与 AI 配置 / AI 偏好的持久化读写。
 * 业务逻辑放在 StoreService，这里只做入参校验与桥接。
 */
import { app, ipcMain } from 'electron'
import type { AiPrefs, AiServiceConfig, AppSettings } from '@shared/index'
import { StoreService } from '../services/StoreService'
import { ShortcutService } from '../services/ShortcutService'
import { syncLoginItem } from '../index'

export function registerConfigIpc(): void {
  ipcMain.handle('config:getSiderCollapsed', () => StoreService.getSiderCollapsed())

  ipcMain.handle('config:setSiderCollapsed', (_e, value: unknown) => {
    if (typeof value !== 'boolean') return
    StoreService.setSiderCollapsed(value)
  })

  /* ---------- AI 服务 ---------- */
  ipcMain.handle('ai:getService', () => StoreService.getAiService())

  ipcMain.handle('ai:setService', (_e, cfg: unknown) => {
    if (!isObject(cfg)) throw new Error('AI 服务配置非法')
    StoreService.setAiService(cfg as unknown as AiServiceConfig)
  })

  ipcMain.handle('ai:resetRules', () => StoreService.resetAiRules())

  /* ---------- AI 偏好 ---------- */
  ipcMain.handle('ai:getPrefs', () => StoreService.getAiPrefs())

  ipcMain.handle('ai:setPrefs', (_e, prefs: unknown) => {
    if (!isObject(prefs)) throw new Error('AI 偏好非法')
    StoreService.setAiPrefs(prefs as unknown as AiPrefs)
  })

  /* ---------- 应用级设置（开机自启 / 最小化到托盘 / 关闭确认） ---------- */
  ipcMain.handle('app:getSettings', () => StoreService.getAppSettings())

  ipcMain.handle('app:setSettings', (_e, settings: unknown) => {
    if (!isObject(settings)) throw new Error('应用设置非法')
    StoreService.setAppSettings(settings as unknown as AppSettings)
    const next = StoreService.getAppSettings()
    // 同步系统登录项（含静默启动 --hidden 参数注入）
    syncLoginItem()
    // 同步全局快捷键（开关/键位变更后立即生效）
    ShortcutService.refresh()
    return next
  })

  // 读取系统真实的登录项状态（兼容旧机器 / 用户在系统层面手动改过的情况）
  ipcMain.handle('app:getLaunchAtLogin', () => {
    return app.getLoginItemSettings().openAtLogin
  })
}

/** 仅判断是否为普通对象（排除 null/数组） */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
