/**
 * AI 服务（主进程）
 * --------------------------------------------------
 * 封装 OpenAI Chat Completions 与 Anthropic Messages 两种协议的流式生成。
 * 网络层用 Node 内置 fetch（不引 axios）。
 *
 * endpoint 解析由 resolveEndpoint 统一完成：
 *   - provider=glm：固定 base（OpenAI 兼容），拼 /chat/completions
 *   - provider=deepseek：固定 base（openai/anthropic 各一套），拼对应路径
 *   - provider=custom：
 *       openai:  urlMode=auto → baseUrl + '/chat/completions'
 *                urlMode=full → baseUrl 原样
 *       anthropic: urlMode=auto → baseUrl + '/messages'
 *                  urlMode=full → baseUrl 原样
 */
import type { AiMessage, AiServiceConfig } from '@shared/index'

/** glm（智谱 BigModel）固定 base（OpenAI 兼容） */
const GLM_BASE = 'https://open.bigmodel.cn/api/paas/v4'

/** deepseek 固定 base（OpenAI 兼容 / Anthropic 兼容各一套） */
const DEEPSEEK_BASE: Record<'openai' | 'anthropic', string> = {
  openai: 'https://api.deepseek.com',
  anthropic: 'https://api.deepseek.com/anthropic'
}

/** 去掉尾部斜杠，避免拼出双斜杠 */
function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/** 当前配置是否为预选 GLM 服务商 */
function isGlm(config: AiServiceConfig): boolean {
  return config.provider === 'glm'
}

/**
 * 解析最终请求 URL 与有效模型 id。
 * @returns { url, model }
 */
export function resolveEndpoint(config: AiServiceConfig): { url: string; model: string } {
  // 预选服务商：glm（OpenAI 兼容，固定走 /chat/completions）
  if (config.provider === 'glm') {
    const model = config.presetCustomModel ? config.model.trim() : config.presetModel
    return { url: trimSlash(GLM_BASE) + '/chat/completions', model }
  }

  // 预选服务商：deepseek
  if (config.provider === 'deepseek') {
    const base = DEEPSEEK_BASE[config.protocol]
    const model = config.presetCustomModel ? config.model.trim() : config.presetModel
    const path = config.protocol === 'openai' ? '/chat/completions' : '/messages'
    return { url: trimSlash(base) + path, model }
  }

  // 自定义
  const base = trimSlash(config.baseUrl)
  if (config.urlMode === 'full') {
    return { url: config.baseUrl, model: config.model.trim() }
  }
  const path = config.protocol === 'openai' ? '/chat/completions' : '/messages'
  return { url: base + path, model: config.model.trim() }
}

/** 快速校验配置是否可用（返回错误信息或 null） */
export function validateConfig(config: AiServiceConfig): string | null {
  if (!config.apiKey || !config.apiKey.trim()) return '未配置 API Key'
  const { model } = resolveEndpoint(config)
  if (!model) return '未配置模型 ID'
  const { url } = resolveEndpoint(config)
  if (!url || !/^https?:\/\//i.test(url)) return '请求地址不合法'
  return null
}

interface StreamCallbacks {
  onChunk: (delta: string) => void
  signal: AbortSignal
}

/**
 * 发起流式生成。两种协议的 SSE 解析各走各的，对外统一 onChunk 回调。
 * 失败时抛出含 HTTP status 与响应体的 Error（供 IPC 透传到渲染进程）。
 */
export async function streamGenerate(
  config: AiServiceConfig,
  messages: AiMessage[],
  cb: StreamCallbacks
): Promise<void> {
  // 调试用：在主进程终端打印发送给 AI 的完整 prompt（system + user）。
  // 渲染进程 DevTools 也有同样打印（见 useAiStore.generate）；这里便于
  // 不开 DevTools 时在开发终端直接查看。
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[AI Prompt]%c ${messages.length} msgs · ${config.provider}/${config.protocol}` +
        ` · ${config.thinking ? `thinking:${config.thinkingEffort}` : 'thinking:off'}`,
      'color:#4f46e5;font-weight:600',
      'color:inherit'
    )
    for (const m of messages) {
      // eslint-disable-next-line no-console
      console.log(`%c[${m.role}] (${m.content.length} chars)`, 'color:#4f46e5;font-weight:600')
      // eslint-disable-next-line no-console
      console.log(m.content)
    }
    // eslint-disable-next-line no-console
    console.groupEnd()
  }

  if (config.protocol === 'openai') {
    await streamOpenAI(config, messages, cb)
  } else {
    await streamAnthropic(config, messages, cb)
  }
}

/* ---------- OpenAI Chat Completions ---------- */
async function streamOpenAI(
  config: AiServiceConfig,
  messages: AiMessage[],
  cb: StreamCallbacks
): Promise<void> {
  const { url, model } = resolveEndpoint(config)
  const res = await fetch(url, {
    method: 'POST',
    signal: cb.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      // 思考模式（DeepSeek / Anthropic 兼容端点）：开启时传 thinking + reasoning_effort；
      // 流式响应中思维链在 delta.reasoning_content，最终回答在 delta.content，
      // 下面解析只取 content，reasoning 被静默丢弃。
      // GLM 不接收这两个参数（思考机制不同，传未知参数会被服务端拒绝），故仅非 glm 时附加。
      ...(!isGlm(config) && config.thinking
        ? { thinking: { type: 'enabled' }, reasoning_effort: config.thinkingEffort }
        : {})
    })
  })

  if (!res.ok || !res.body) {
    const text = await safeReadText(res)
    throw new Error(httpErrMsg(res.status, text))
  }

  await parseSse(res.body, cb.signal, (data) => {
    if (data === '[DONE]') return
    try {
      const json = JSON.parse(data) as {
        // content 为最终回答；reasoning_content 为思考过程（思考模式），这里不读、静默丢弃
        choices?: { delta?: { content?: string; reasoning_content?: string } }[]
      }
      const delta = json.choices?.[0]?.delta?.content
      if (delta) cb.onChunk(delta)
    } catch {
      // 忽略无法解析的行（心跳/注释）
    }
  })
}

/* ---------- Anthropic Messages ---------- */
async function streamAnthropic(
  config: AiServiceConfig,
  messages: AiMessage[],
  cb: StreamCallbacks
): Promise<void> {
  const { url, model } = resolveEndpoint(config)

  // Anthropic：system 单独传，messages 只含 user/assistant
  const systemMsg = messages.find((m) => m.role === 'system')
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))

  const res = await fetch(url, {
    method: 'POST',
    signal: cb.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: turns,
      max_tokens: 1024,
      stream: true,
      // 思考模式（Anthropic 兼容端点）：开启时传 output_config.effort；
      // 思维链增量会被 parseSse 过滤（仅 content_block_delta 的 text 增量会被采纳）。
      ...(config.thinking ? { output_config: { effort: config.thinkingEffort } } : {})
    })
  })

  if (!res.ok || !res.body) {
    const text = await safeReadText(res)
    throw new Error(httpErrMsg(res.status, text))
  }

  await parseSse(res.body, cb.signal, (data) => {
    try {
      const json = JSON.parse(data) as {
        type?: string
        delta?: { type?: string; text?: string }
      }
      // content_block_delta 事件携带增量文本
      if (json.type === 'content_block_delta' && json.delta?.text) {
        cb.onChunk(json.delta.text)
      }
    } catch {
      // 忽略无法解析的行
    }
  })
}

/* ---------- SSE 通用解析 ---------- */
/**
 * 逐行读取 SSE 流。按空行分隔事件块，提取每个块里所有 `data:` 行拼接后回调。
 * 兼容 OpenAI（一行一个 data）与 Anthropic（事件 + data 行）。
 */
async function parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (data: string) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => {})
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // 按行处理，遇到空行（事件边界）则 flush
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)

        if (line === '') {
          // 事件分隔，忽略（本实现逐行即可处理）
          continue
        }
        if (line.startsWith(':')) {
          // SSE 注释 / 心跳
          continue
        }
        if (line.startsWith('data:')) {
          const data = line.slice(5).replace(/^\s/, '')
          onData(data)
        }
        // event:/id:/retry: 行不处理
      }
    }
    // flush 残留
    const remaining = buffer.trim()
    if (remaining.startsWith('data:')) {
      onData(remaining.slice(5).replace(/^\s/, ''))
    }
  } finally {
    reader.releaseLock()
  }
}

/** 安全读取错误响应文本（有大小限制） */
async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.length > 500 ? t.slice(0, 500) + '…' : t
  } catch {
    return ''
  }
}

function httpErrMsg(status: number, body: string): string {
  const map: Record<number, string> = {
    400: '请求格式错误（400）',
    401: 'API Key 无效或未授权（401）',
    403: '被拒绝访问（403）',
    404: '请求地址或模型不存在（404）',
    429: '请求过于频繁或额度不足（429）',
    500: '服务端错误（500）',
    502: '网关错误（502）',
    503: '服务暂不可用（503）',
    504: '请求超时（504）'
  }
  const prefix = map[status] ?? `请求失败（HTTP ${status}）`
  const detail = body ? `\n${body}` : ''
  return prefix + detail
}

/* ---------- 连通性测试 ---------- */
/** 连通性测试超时（仅防代理 hang；DNS 失败/拒连会快速返回） */
const TEST_TIMEOUT_MS = 15000

/**
 * 连通性测试：用最小非流式请求验证鉴权 / 地址 / 模型可达性。
 *
 * 与 streamGenerate 区别：不流式、不关心返回内容、不带 thinking 参数
 * （思考模式更慢更贵，对连通性验证无意义）。成功 resolve void，失败抛含
 * HTTP status 与响应体的 Error（文案复用 httpErrMsg，天然适配 401/429 等）。
 */
export async function testConnection(config: AiServiceConfig): Promise<void> {
  const { url, model } = resolveEndpoint(config)
  // 最小请求体：只验证鉴权 / 地址 / 模型可达性，两协议字段一致
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false
  })

  const headers: Record<string, string> =
    config.protocol === 'openai'
      ? { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
      : {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        }

  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    headers,
    body
  })
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(httpErrMsg(res.status, text))
  }
}
