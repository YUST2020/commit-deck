/**
 * 差异聚合器（供 AI 生成提交信息）
 * --------------------------------------------------
 * 规则（对应需求第 5 条）：
 *   1. 有暂存内容 → 只发暂存 diff；无暂存 → 发全量工作区改动
 *   2. 大文件保护：二进制 / 超长单文件 / 锁文件与产物 / 非文本扩展名 → 折叠或剔除内容
 *   3. 总量保护：聚合后超上限 → 截断并标记 truncated
 *
 * 输出为类 unified diff 文本，喂给 AI 作为 user message。
 */
import path from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'
import type { DiffForAi, OmittedFile } from '@shared/index'

/* ---------- 阈值常量（集中，便于调优） ---------- */
/** 单文件 diff 超过该字符数则折叠（仅保留头 + 增删行统计） */
const MAX_FILE_CHARS = 15000
/**
 * 聚合后总字符数上限（fallback）：未提供模型信息时使用。
 * 提供模型时会按上下文长度动态推算（见 computeMaxDiffChars）。
 */
const MAX_TOTAL_CHARS = 30000
/** 读取未跟踪文件内容时的单文件大小上限（字节），超过则不读内容 */
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 // 64KB

/* ---------- 模型上下文推算 ---------- */
/**
 * 已知模型 → 上下文 token 数（粗略映射）。
 * 按数组顺序匹配，第一个命中的生效；最后一项兜底所有未知模型为 8K。
 * 维护：新增模型时按其官方标称上下文长度补一条 pattern。
 */
const MODEL_CONTEXT_MAP: Array<{ pattern: RegExp; ctx: number }> = [
  // 超长上下文（200K）：glm-4.7 系列（含 glm-4.7-flash）
  { pattern: /glm-4\.7/i, ctx: 200_000 },
  // 长上下文（128K）
  { pattern: /gpt-4o|claude-3.*sonnet|glm-4|qwen-?2\.5|deepseek.*(v3|v4)/i, ctx: 128_000 },
  // 中等上下文（32K）
  { pattern: /gpt-4|claude-3.*haiku|qwen-?7/i, ctx: 32_000 },
  // 小模型 / 未知
  { pattern: /.*/, ctx: 8_000 }
]

/**
 * 按模型推算可用的 diff 字符数上限。
 * 预留 4K token 给 system prompt + 输出；字符数 ≈ token × 2.5（中文保守值）。
 * 未知模型（model 为空或未命中）回落到 MAX_TOTAL_CHARS。
 */
export function computeMaxDiffChars(model: string | undefined): number {
  if (!model || !model.trim()) return MAX_TOTAL_CHARS
  const entry = MODEL_CONTEXT_MAP.find((m) => m.pattern.test(model))
  const ctx = entry?.ctx ?? 8_000
  const usable = Math.max(ctx - 4_000, 4_000)
  return Math.floor(usable * 2.5)
}

/** 默认按二进制/产物处理的扩展名 */
const BINARY_EXTENSIONS = new Set([
  // 图片
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'svg',
  // 音视频
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'flv', 'webm', 'ogg',
  // 压缩包
  'zip', 'gz', 'tar', 'rar', '7z', 'bz2', 'xz',
  // 可执行/库
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war',
  // 文档（二进制）
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // 字体
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // 其它
  'db', 'sqlite', 'pyc', 'wasm', 'pak'
])

/** 锁文件 / 产物文件名（精确匹配） */
const LOCK_OR_GEN_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'cargo.lock',
  'go.sum',
  'flake.lock'
])

/** 产物路径片段（路径中包含即视为产物，剔除内容） */
const GENERATED_PATH_SEGMENTS = ['node_modules/', 'dist/', 'build/', 'out/', '.next/', '.nuxt/', 'vendor/', '__pycache__/', '.cache/']

/** 产物文件名后缀（如 min.js / .map） */
const GENERATED_SUFFIXES = ['.min.js', '.min.css', '.map', '.bundle.js', '.bundle.css']

function lowerExt(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return ext
}

function fileName(filePath: string): string {
  const base = path.basename(filePath)
  return base
}

/**
 * 文件重要性优先级（数字越大越优先装填进 AI 上下文）。
 * 排序约定：源码 > 文档/配置 > 样式 > 测试。
 * - 改动行数适中（20~200）的源码加权，过小/过大的次之
 * - 折叠文件（二进制/产物/超长）不参与裁剪竞争（占空间小，直接纳入）
 */
function filePriority(filePath: string, changeLines: number): number {
  const ext = lowerExt(filePath)
  const base = fileName(filePath).toLowerCase()
  // 测试文件最低
  if (/\.(test|spec)\./i.test(base) || /^(test|spec)[._-]/i.test(base)) return 0
  if (ext === 'snap' || ext === 'snap.txt') return 0
  // 样式
  if (['css', 'scss', 'sass', 'less', 'styl'].includes(ext)) return 1
  // 文档 / 配置
  if (['md', 'txt', 'mdx', 'json', 'yml', 'yaml', 'toml', 'ini', 'env'].includes(ext)) return 2
  // 源码（默认）—— 改动行数适中加权
  const lineScore = changeLines >= 20 && changeLines <= 200 ? 2 : 1
  return 10 + lineScore
}

/** 判断是否应折叠内容（二进制 / 产物 / 锁文件） */
function shouldOmitContent(filePath: string): {
  omit: boolean
  reason: Omit<OmittedFile, 'path'> | null
} {
  const ext = lowerExt(filePath)
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return {
      omit: true,
      reason: { reason: 'binary', note: '二进制文件，内容已省略' }
    }
  }
  const base = fileName(filePath)
  if (LOCK_OR_GEN_FILES.has(base)) {
    return {
      omit: true,
      reason: { reason: 'generated', note: '锁文件 / 产物，内容已省略' }
    }
  }
  const lower = filePath.toLowerCase()
  for (const seg of GENERATED_PATH_SEGMENTS) {
    if (lower.includes(seg)) {
      return {
        omit: true,
        reason: { reason: 'generated', note: `产物目录（${seg}），内容已省略` }
      }
    }
  }
  for (const suf of GENERATED_SUFFIXES) {
    if (lower.endsWith(suf)) {
      return {
        omit: true,
        reason: { reason: 'generated', note: '压缩/混淆产物，内容已省略' }
      }
    }
  }
  return { omit: false, reason: null }
}

/** 把 OmittedFile reason + note 转成 diff 文本里的折叠说明行 */
function omittedLine(r: Omit<OmittedFile, 'path'>): string {
  return `[${r.note}]\n`
}

/** 统计 diff 块的 +N / -M 行数 */
function countAddDel(diffBlock: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of diffBlock.split('\n')) {
    // 排除 hunk 头与文件元信息行
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
}

/** 处理结果：折叠后的 diff 文本 + 该文件是否被忽略（及原因） */
interface ProcessedFile {
  text: string
  omitted: Omit<OmittedFile, 'path'> | null
}

/**
 * 处理单个文件的 diff 文本：
 * - 产物/锁/二进制 → 仅保留 diff 头 + 折叠说明
 * - 超长 → 保留头 + 折叠统计
 * - 否则原样返回
 */
function processFileDiff(diffBlock: string, filePath: string): ProcessedFile {
  const { omit, reason } = shouldOmitContent(filePath)
  if (omit && reason) {
    return { text: keepHeader(diffBlock) + omittedLine(reason), omitted: reason }
  }
  // 补缺口：git 对无法文本解析的二进制文件输出 "Binary files a/x and b/x differ"，
  // 扩展名不在黑名单（如 .dat / .bin / 无扩展名）时也会命中。统一折叠。
  if (/Binary files .+ and .+ differ/i.test(diffBlock)) {
    const r: Omit<OmittedFile, 'path'> = {
      reason: 'binary',
      note: '二进制文件，内容已省略'
    }
    return { text: keepHeader(diffBlock) + omittedLine(r), omitted: r }
  }
  if (diffBlock.length > MAX_FILE_CHARS) {
    const { add, del } = countAddDel(diffBlock)
    const r: Omit<OmittedFile, 'path'> = {
      reason: 'too_large',
      note: `单文件过大（+${add} -${del} 行），已折叠`
    }
    return { text: keepHeader(diffBlock) + omittedLine(r), omitted: r }
  }
  return { text: diffBlock, omitted: null }
}

/** 提取 diff 块的文件头部分（diff / index / --- / +++ 等行，到第一个 hunk 之前） */
function keepHeader(diffBlock: string): string {
  const lines = diffBlock.split('\n')
  const header: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@')) break
    header.push(line)
  }
  return header.join('\n') + '\n'
}

/**
 * 把整段 staged diff 按文件切分后逐个过滤，再按重要性装填，最后聚合。
 *
 * 装填策略（保证重要文件优先进入上下文）：
 *   1. 按 `diff --git ` 切块，逐个 processFileDiff（折叠产物/二进制/超长）
 *   2. 折叠文件（占空间极小，仅头+说明行）直接纳入，不参与裁剪竞争
 *   3. 未折叠文件按 filePriority 降序（源码 > 配置 > 样式 > 测试）+ 改动行数加权，
 *      依次累加直到达到 maxTotalChars
 *   4. 落选文件仅保留 diff 头 + 截断标记，记入 omitted
 *   5. 输出仍按文件原顺序，保持 diff 阅读连贯
 */
function filterAggregatedDiff(
  rawDiff: string,
  omitted: OmittedFile[],
  maxTotalChars: number
): { diff: string; truncated: boolean } {
  if (!rawDiff.trim()) return { diff: '', truncated: false }

  const blocks = splitByFile(rawDiff)
  type Item = {
    filePath: string
    processed: ProcessedFile
    order: number
    block: string
  }
  const items: Item[] = blocks.map((block, order) => {
    const filePath = extractFilePath(block) ?? `__unknown_${order}`
    const processed = processFileDiff(block, filePath)
    return { filePath, processed, order, block }
  })

  // 装填选择集：折叠文件必进；未折叠文件按优先级竞争配额
  const keepSet = new Set<number>()
  let total = 0

  // 先吸纳所有折叠文件（占空间小，价值在于"告知存在"）
  for (const it of items) {
    if (it.processed.omitted) {
      keepSet.add(it.order)
      total += it.processed.text.length
    }
  }

  // 未折叠文件按优先级排序（稳定：同优先级按原顺序）
  const unfolded = items
    .filter((it) => !it.processed.omitted)
    .map((it) => ({
      it,
      priority: filePriority(it.filePath, (() => {
        const { add, del } = countAddDel(it.processed.text)
        return add + del
      })())
    }))
    .sort((a, b) => b.priority - a.priority || a.it.order - b.it.order)

  for (const { it } of unfolded) {
    if (total + it.processed.text.length > maxTotalChars) continue
    keepSet.add(it.order)
    total += it.processed.text.length
  }

  const truncated = items.some((it) => !keepSet.has(it.order))
  const sizeLimitReason: Omit<OmittedFile, 'path'> = {
    reason: 'size_limit',
    note: '总量超限，内容已省略'
  }

  // 按原顺序输出（保持 diff 阅读连贯）
  const out: string[] = []
  for (const it of items) {
    if (keepSet.has(it.order)) {
      out.push(it.processed.text)
      if (it.processed.omitted) {
        omitted.push({ path: it.filePath, ...it.processed.omitted })
      }
    } else {
      out.push(keepHeader(it.block) + omittedLine(sizeLimitReason))
      omitted.push({ path: it.filePath, ...sizeLimitReason })
    }
  }

  return { diff: out.join('').trimEnd(), truncated }
}

/** 按 `diff --git ` 分块 */
function splitByFile(rawDiff: string): string[] {
  const parts = rawDiff.split(/(?=^diff --git )/m)
  return parts.map((s) => s).filter((s) => s.trim().length > 0)
}

/** 从 diff 块中提取文件路径（取 +++ b/xxx） */
function extractFilePath(block: string): string | null {
  const m = block.match(/^\+\+\+ b\/(.+)$/m)
  if (m) return m[1]
  // 删除文件时 +++ /dev/null，取 --- a/xxx
  const m2 = block.match(/^--- a\/(.+)$/m)
  if (m2) return m2[1]
  // fallback: diff --git a/x b/x
  const m3 = block.match(/^diff --git a\/\S+ b\/(.+)$/m)
  if (m3) return m3[1]
  return null
}

/**
 * 为未跟踪文件生成类 diff 文本（全为新增行）。
 * - 读文件内容前先判大小与扩展名，避免读入巨型/二进制文件。
 * 返回处理后的文本 + 被忽略原因（若有）。
 */
function diffForUntracked(
  git: SimpleGit,
  repoPath: string,
  filePath: string
): Promise<ProcessedFile> {
  return (async () => {
    void git
    const { omit, reason } = shouldOmitContent(filePath)
    const header =
      `diff --git a/${filePath} b/${filePath}\n` +
      `new file mode 100644\n` +
      `--- /dev/null\n` +
      `+++ b/${filePath}\n`
    if (omit && reason) {
      return { text: header + omittedLine(reason), omitted: reason }
    }
    // 读文件内容（带大小上限）
    const abs = path.join(repoPath, filePath)
    const fs = await import('fs')
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      return { text: header + '[file not readable]\n', omitted: null }
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      const r: Omit<OmittedFile, 'path'> = {
        reason: 'too_large',
        note: `未跟踪文件过大（${Math.round(stat.size / 1024)}KB），内容已省略`
      }
      return { text: header + omittedLine(r), omitted: r }
    }
    let content: string
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch {
      return { text: header + '[file not readable]\n', omitted: null }
    }
    // 检测是否包含 NUL 字节（典型二进制特征），有则折叠
    if (content.includes('\0')) {
      const r: Omit<OmittedFile, 'path'> = {
        reason: 'binary',
        note: '二进制文件，内容已省略'
      }
      return { text: header + omittedLine(r), omitted: r }
    }
    const lines = content.split('\n')
    const body = lines.map((l) => '+' + l).join('\n')
    const block = header + '@@ -0,0 +1,' + lines.length + ' @@\n' + body + '\n'
    // 走 processFileDiff 统一处理超长折叠
    return processFileDiff(block, filePath)
  })()
}

/**
 * 聚合 diff 供 AI 使用。
 * - 有暂存 → source='staged'，仅取 --cached diff
 * - 无暂存 → source='all'，取工作区已跟踪文件 diff + 未跟踪文件内容
 *
 * @param repoPath 仓库绝对路径
 * @param model    AI 模型 id（用于按上下文长度动态推算总量上限；为空则用 fallback 常量）
 */
export async function aggregateDiffForAi(
  repoPath: string,
  model?: string
): Promise<DiffForAi> {
  const git: SimpleGit = simpleGit({ baseDir: repoPath, binary: 'git', maxConcurrentProcesses: 4 })
  const omitted: OmittedFile[] = []
  const maxTotal = computeMaxDiffChars(model)

  // 1. 优先尝试暂存 diff
  const stagedRaw = await git.diff(['--cached'])
  if (stagedRaw.trim()) {
    const { diff, truncated } = filterAggregatedDiff(stagedRaw, omitted, maxTotal)
    return { diff, truncated, omittedFiles: omitted, source: 'staged' }
  }

  // 2. 无暂存 → 全量工作区改动
  // 2a. 已跟踪文件的改动（modified/deleted，不含 untracked）
  const trackedRaw = await git.diff(['--']) // 默认不含未跟踪
  const parts: string[] = []
  let truncated = false
  let used = 0 // 已用配额（字符）
  if (trackedRaw.trim()) {
    const r = filterAggregatedDiff(trackedRaw, omitted, maxTotal)
    parts.push(r.diff)
    truncated = truncated || r.truncated
    used += r.diff.length
  }

  // 2b. 未跟踪文件：用 git status 取列表，逐个生成内容 diff
  const st = await git.status()
  const untracked = st.not_added ?? []

  // 收集每个未跟踪文件的处理结果，再按优先级在剩余配额内装填
  type UntrackedItem = { filePath: string; processed: ProcessedFile; order: number }
  const untrackedItems: UntrackedItem[] = []
  for (const f of untracked) {
    const processed = await diffForUntracked(git, repoPath, f)
    untrackedItems.push({ filePath: f, processed, order: untrackedItems.length })
  }

  const sizeLimitReason: Omit<OmittedFile, 'path'> = {
    reason: 'size_limit',
    note: '总量超限，内容已省略'
  }

  // 折叠文件（产物/二进制/超长）必进；未折叠按优先级排序后在剩余配额内装填
  const keepSet = new Set<number>()
  for (const it of untrackedItems) {
    if (it.processed.omitted) {
      keepSet.add(it.order)
      used += it.processed.text.length
    }
  }
  const unfoldedUntracked = untrackedItems
    .filter((it) => !it.processed.omitted)
    .map((it) => ({
      it,
      priority: filePriority(
        it.filePath,
        (() => {
          const { add, del } = countAddDel(it.processed.text)
          return add + del
        })()
      )
    }))
    .sort((a, b) => b.priority - a.priority || a.it.order - b.it.order)
  for (const { it } of unfoldedUntracked) {
    if (used + it.processed.text.length > maxTotal) continue
    keepSet.add(it.order)
    used += it.processed.text.length
  }

  // 按原顺序输出未跟踪文件
  for (const it of untrackedItems) {
    if (keepSet.has(it.order)) {
      parts.push(it.processed.text)
      if (it.processed.omitted) {
        omitted.push({ path: it.filePath, ...it.processed.omitted })
      }
    } else {
      truncated = true
      parts.push(
        `diff --git a/${it.filePath} b/${it.filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${it.filePath}\n${omittedLine(sizeLimitReason)}`
      )
      omitted.push({ path: it.filePath, ...sizeLimitReason })
    }
  }

  const diff = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  return { diff, truncated, omittedFiles: omitted, source: 'all' }
}
