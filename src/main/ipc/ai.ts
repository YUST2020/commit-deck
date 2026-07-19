/**
 * AI 相关 IPC handler
 * --------------------------------------------------
 * 流式生成用「invoke 启动 + 事件推增量」组合：
 *   - 渲染进程 invoke('ai:generate', {...}) 启动一次生成
 *   - 主进程通过 e.sender.send('ai:chunk'/'ai:done'/'ai:error') 推送流事件
 *   - 渲染进程 invoke('ai:abort') 中断当前流
 *
 * 每个 webContents（窗口）维护一个独立的 AbortController，互不干扰。
 *
 * 任务分发（task）：同一套流式传输通道承载多种任务（生成 commit message / 代码审查）。
 * 入参 payload.task 决定推送到哪一组事件：
 *   - 'commit'（默认）→ 'ai:chunk' / 'ai:done' / 'ai:error'（由 useAiStore 订阅）
 *   - 'review'        → 'ai:review:chunk' / 'ai:review:done' / 'ai:review:error'（由 useCodeReviewStore 订阅）
 * 这样两个任务的流事件彻底解耦，互不污染对方 buffer；
 * 单流约束仍由 controllers Map 保证（同窗口任意时刻只能跑一个任务，新任务启动会 abort 旧任务）。
 */
type AiTask = 'commit' | 'review'

/** 根据任务类型解析该次流应推送的事件名三元组 */
function eventsFor(task: AiTask): { chunk: string; done: string; error: string } {
  return task === 'review'
    ? { chunk: 'ai:review:chunk', done: 'ai:review:done', error: 'ai:review:error' }
    : { chunk: 'ai:chunk', done: 'ai:done', error: 'ai:error' }
}
import path from 'path'
import { ipcMain, type WebContents } from 'electron'
import type { AiMessage, AiServiceConfig } from '@shared/index'
import { streamGenerate, testConnection, validateConfig } from '../services/AiService'

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
      payload: { repoPath: unknown; config: unknown; messages: unknown; task?: unknown }
    ) => {
      try {
        assertValidPath(payload.repoPath)
        const config = payload.config as AiServiceConfig
        const messages = payload.messages as AiMessage[]
        if (!config || typeof config !== 'object') throw new Error('AI 配置缺失')
        if (!Array.isArray(messages)) throw new Error('messages 必须是数组')
        const task: AiTask = payload.task === 'review' ? 'review' : 'commit'
        const ev = eventsFor(task)

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
              if (!sender.isDestroyed()) sender.send(ev.chunk, delta)
            }
          })
          if (!sender.isDestroyed()) sender.send(ev.done)
          return { ok: true as const }
        } catch (streamErr) {
          // 用户主动中断（AbortError）→ 视为 done 而非 error
          if (controller.signal.aborted) {
            if (!sender.isDestroyed()) sender.send(ev.done)
            return { ok: true as const }
          }
          const msg = streamErr instanceof Error ? streamErr.message : '生成失败'
          if (!sender.isDestroyed()) sender.send(ev.error, { message: msg })
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

  // 连通性测试：用最小非流式请求验证配置可达。一次性 invoke，无流事件，
  // 不进 controllers map（与 ai:generate 区分）。
  // 入参直接为 config（preload 透传 testAiConnection(config)）。
  ipcMain.handle('ai:test', async (_e, config: unknown) => {
    try {
      if (!config || typeof config !== 'object') {
        return { ok: false as const, error: 'AI 配置缺失' }
      }
      const err = validateConfig(config as AiServiceConfig)
      if (err) return { ok: false as const, error: err }
      await testConnection(config as AiServiceConfig)
      return { ok: true as const }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '连接测试失败'
      return { ok: false as const, error: msg }
    }
  })
}
