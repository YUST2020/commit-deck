/**
 * AI 相关 IPC handler
 * --------------------------------------------------
 * 流式生成用「invoke 启动 + 事件推增量」组合：
 *   - 渲染进程 invoke('ai:generate', {...}) 启动一次生成
 *   - 主进程通过 e.sender.send('ai:chunk'/'ai:done'/'ai:error') 推送流事件
 *   - 渲染进程 invoke('ai:abort') 中断当前流
 *
 * 每个 webContents（窗口）维护一个独立的 AbortController，互不干扰。
 */
import path from 'path'
import { ipcMain, type WebContents } from 'electron'
import type { AiMessage, AiServiceConfig } from '@shared/index'
import { streamGenerate, validateConfig } from '../services/AiService'

/** 校验路径必须是绝对路径 */
function assertValidPath(p: unknown): asserts p is string {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) {
    throw new Error('非法的项目路径')
  }
}

/** 每个发件人对应的当前 AbortController（同窗口同时只允许一个进行中的流） */
const controllers = new Map<WebContents, AbortController>()

function clearController(sender: WebContents): void {
  controllers.delete(sender)
}

export function registerAiIpc(): void {
  ipcMain.handle(
    'ai:generate',
    async (
      e,
      payload: { repoPath: unknown; config: unknown; messages: unknown }
    ) => {
      try {
        assertValidPath(payload.repoPath)
        const config = payload.config as AiServiceConfig
        const messages = payload.messages as AiMessage[]
        if (!config || typeof config !== 'object') throw new Error('AI 配置缺失')
        if (!Array.isArray(messages)) throw new Error('messages 必须是数组')

        // 预检
        const err = validateConfig(config)
        if (err) return { ok: false as const, error: err }

        // 中断该窗口可能存在的旧流（理论上不该出现，防御）
        const old = controllers.get(e.sender)
        if (old) old.abort()
        const controller = new AbortController()
        controllers.set(e.sender, controller)

        const sender = e.sender
        // 发件人销毁时清理，避免内存泄漏
        const onDestroy = (): void => clearController(sender)
        sender.once('destroyed', onDestroy)

        try {
          await streamGenerate(config, messages, {
            signal: controller.signal,
            onChunk: (delta) => {
              if (!sender.isDestroyed()) sender.send('ai:chunk', delta)
            }
          })
          if (!sender.isDestroyed()) sender.send('ai:done')
          return { ok: true as const }
        } catch (streamErr) {
          // 用户主动中断（AbortError）→ 视为 done 而非 error
          if (controller.signal.aborted) {
            if (!sender.isDestroyed()) sender.send('ai:done')
            return { ok: true as const }
          }
          const msg = streamErr instanceof Error ? streamErr.message : '生成失败'
          if (!sender.isDestroyed()) sender.send('ai:error', { message: msg })
          return { ok: false as const, error: msg }
        } finally {
          clearController(sender)
          sender.removeListener('destroyed', onDestroy)
        }
      } catch (e2) {
        const msg = e2 instanceof Error ? e2.message : '启动生成失败'
        return { ok: false as const, error: msg }
      }
    }
  )

  ipcMain.handle('ai:abort', (e) => {
    const controller = controllers.get(e.sender)
    if (controller) controller.abort()
    return
  })
}
