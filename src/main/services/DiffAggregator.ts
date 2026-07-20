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
 * 聚合后总字符数上限：固定按 128K token 上下文推算。
 * 预留 2K token 给 system prompt + 输出，1 token ≈ 3.5 字符（代码 diff 以 ASCII 为主）。
 * (128000 − 2000) × 3.5 ≈ 441000 字符。
 */
const MAX_TOTAL_CHARS = Math.floor((128_000 - 2_000) * 3.5) // 441000
/** 读取未跟踪文件内容时的单文件大小上限（字节），超过则不读内容 */
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 // 64KB

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

/**
 * 判断是否应折叠内容（二进制 / 产物 / 锁文件）。
 * 同时供文件选择器（listChangedFilesForReview）判定哪些文件内容会被规则折叠，
 * 以在选择器中禁用勾选——保证「选择器展示」与「聚合实际处理」用同一套规则（DRY）。
 */
export function classifyOmit(filePath: string): {
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
 * - 产物/锁/二进制 → 仅保留 diff 头 + 折叠说明（强制包含也无法解析，仍折叠）
 * - 超长 → 保留头 + 折叠统计（force=true 时跳过此折叠，保留全文）
 * - 否则原样返回
 *
 * @param force 强制包含：true 时不因单文件过大折叠（用户明确要求发送全文）
 */
function processFileDiff(diffBlock: string, filePath: string, force = false): ProcessedFile {
  const { omit, reason } = classifyOmit(filePath)
  if (omit && reason) {
    return { text: keepHeader(diffBlock) + omittedLine(reason), omitted: reason }
  }
  // 补缺口：git 对无法文本解析的二进制文件输出 "Binary files a/x and b/x differ"，
  // 扩展名不在黑名单（如 .dat / .bin / 无扩展名）时也会命中。统一折叠（强制也无效）。
  if (/Binary files .+ and .+ differ/i.test(diffBlock)) {
    const r: Omit<OmittedFile, 'path'> = {
      reason: 'binary',
      note: '二进制文件，内容已省略'
    }
    return { text: keepHeader(diffBlock) + omittedLine(r), omitted: r }
  }
  if (!force && diffBlock.length > MAX_FILE_CHARS) {
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
 * 按 hunk 切分（每个 hunk 以 `@@` 开头，到下一个 `@@` 或结尾）。
 * 返回 [header, hunks[]] —— header 为到首个 `@@` 前的行（含末尾换行）。
 */
function splitHeaderAndHunks(diffBlock: string): { header: string; hunks: string[] } {
  const lines = diffBlock.split('\n')
  const headerLines: string[] = []
  let i = 0
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) break
    headerLines.push(lines[i])
  }
  const header = headerLines.join('\n') + '\n'
  const hunks: string[] = []
  let cur: string[] = []
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('@@') && cur.length > 0) {
      hunks.push(cur.join('\n'))
      cur = []
    }
    cur.push(lines[i])
  }
  if (cur.length > 0) hunks.push(cur.join('\n'))
  return { header, hunks }
}

/**
 * 部分截断一个 diff 块：保留 header + 尽可能多的完整 hunk + 截断标记。
 * 用于强制包含文件在总配额装不下时（「超配额才截断」），保留尽可能多的内容而非整块丢弃。
 *
 * @param block      原始 diff 块（未折叠）
 * @param maxChars   该块允许占用的最大字符数（含 header 与截断标记）
 * @returns 截断后的文本 + 是否发生截断
 */
function truncateHunks(block: string, maxChars: number): { text: string; truncated: boolean } {
  if (block.length <= maxChars) return { text: block, truncated: false }
  const { header, hunks } = splitHeaderAndHunks(block)
  // 截断标记预留
  const marker = '\n[已强制包含，因总量超限部分截断]\n'
  const budget = maxChars - header.length - marker.length
  if (budget <= 0) {
    // 预算连 header 都装不下：退化为仅 header + 标记
    return { text: header + marker, truncated: true }
  }
  const kept: string[] = []
  let used = 0
  for (const hunk of hunks) {
    // 每个 hunk 末尾补一个换行以保持格式
    const piece = hunk + '\n'
    if (used + piece.length > budget) break
    kept.push(piece)
    used += piece.length
  }
  const text = header + kept.join('') + marker
  return { text, truncated: true }
}

/**
 * 把整段 diff 按文件切分后逐个过滤，再按重要性装填，最后聚合。
 *
 * 装填策略（三层优先级，保证重要文件优先进入上下文）：
 *   1. 按 `diff --git ` 切块，逐个 processFileDiff（折叠产物/二进制/超长）
 *   2. 第一优先：forceIncludePaths 命中的未折叠文件，优先占用配额；
 *      装不下时按 hunk 部分截断（保留尽可能多内容），而非整块丢弃
 *   3. 第二优先：折叠文件（占空间极小，仅头+说明行）直接纳入，以"告知存在"
 *   4. 第三优先：未折叠文件按 filePriority 降序（源码 > 配置 > 样式 > 测试）
 *      + 改动行数加权，依次累加直到达到 maxTotalChars
 *   5. 落选文件仅保留 diff 头 + 截断标记，记入 omitted
 *   6. 输出仍按文件原顺序，保持 diff 阅读连贯
 */
function filterAggregatedDiff(
  rawDiff: string,
  omitted: OmittedFile[],
  maxTotalChars: number,
  forceIncludePaths: string[] = []
): { diff: string; truncated: boolean } {
  if (!rawDiff.trim()) return { diff: '', truncated: false }

  const forceSet = new Set(forceIncludePaths)
  const blocks = splitByFile(rawDiff)
  type Item = {
    filePath: string
    processed: ProcessedFile
    order: number
    block: string
    forced: boolean
    /** 最终输出文本（默认等于 processed.text；强制文件部分截断时覆盖为截断后文本） */
    outText: string
    /** 强制文件被部分截断时的标记（null=未截断）；用于记入 omitted */
    forceTruncNote: string | null
  }
  const items: Item[] = blocks.map((block, order) => {
    const filePath = extractFilePath(block) ?? `__unknown_${order}`
    const forced = forceSet.has(filePath)
    const processed = processFileDiff(block, filePath, forced)
    return { filePath, processed, order, block, forced, outText: processed.text, forceTruncNote: null }
  })

  const keepSet = new Set<number>()
  let total = 0

  // 第一优先：强制包含且未折叠的文件（二进制/产物强制无效，仍折叠，归入第二层）
  // 优先占用配额；装不下时部分截断（保留尽可能多 hunk），而非整块丢弃
  for (const it of items) {
    if (it.forced && !it.processed.omitted) {
      if (total + it.outText.length <= maxTotalChars) {
        keepSet.add(it.order)
        total += it.outText.length
      } else {
        const budget = maxTotalChars - total
        // 预算需至少容下 header + 截断标记，否则放弃该强制文件（让其落到 omitted）
        if (budget > keepHeader(it.processed.text).length + 64) {
          const { text } = truncateHunks(it.outText, budget)
          it.outText = text
          it.forceTruncNote = '已强制包含，因总量超限部分截断'
          keepSet.add(it.order)
          total += it.outText.length
        }
      }
    }
  }

  // 第二优先：折叠文件（占空间小，价值在于"告知存在"）
  for (const it of items) {
    if (it.processed.omitted) {
      keepSet.add(it.order)
      total += it.outText.length
    }
  }

  // 第三优先：未折叠非强制文件按优先级排序（稳定：同优先级按原顺序），竞争剩余配额
  const unfolded = items
    .filter((it) => !it.processed.omitted && !it.forced)
    .map((it) => ({
      it,
      priority: filePriority(it.filePath, (() => {
        const { add, del } = countAddDel(it.processed.text)
        return add + del
      })())
    }))
    .sort((a, b) => b.priority - a.priority || a.it.order - b.it.order)

  for (const { it } of unfolded) {
    if (total + it.outText.length > maxTotalChars) continue
    keepSet.add(it.order)
    total += it.outText.length
  }

  // truncated：有文件未纳入，或强制文件被部分截断
  const truncated =
    items.some((it) => !keepSet.has(it.order)) ||
    items.some((it) => it.forceTruncNote !== null)
  const sizeLimitReason: Omit<OmittedFile, 'path'> = {
    reason: 'size_limit',
    note: '总量超限，内容已省略'
  }
  const forceTruncReason: Omit<OmittedFile, 'path'> = {
    reason: 'too_large',
    note: '已强制包含，因总量超限部分截断'
  }

  // 按原顺序输出（保持 diff 阅读连贯）
  const out: string[] = []
  for (const it of items) {
    if (keepSet.has(it.order)) {
      out.push(it.outText)
      // 折叠文件（产物/二进制/超长）记入 omitted
      if (it.processed.omitted) {
        omitted.push({ path: it.filePath, ...it.processed.omitted })
      }
      // 强制文件被部分截断：记入 omitted（reason 复用 too_large）
      if (it.forceTruncNote) {
        omitted.push({ path: it.filePath, ...forceTruncReason })
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

/**
 * 按路径白名单过滤 diff：只保留命中 onlySet 的文件块。
 * 用于代码审查「文件选择器」——用户勾选了哪些文件就只保留这些文件的 diff。
 * 提取不到路径的块（异常）直接丢弃，避免脏数据进入上下文。
 */
function filterBlocksByPaths(rawDiff: string, onlySet: Set<string>): string {
  if (!rawDiff.trim()) return ''
  const blocks = splitByFile(rawDiff)
  const kept = blocks.filter((b) => {
    const fp = extractFilePath(b)
    return fp ? onlySet.has(fp) : false
  })
  return kept.join('')
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
 * - force=true（强制包含）时跳过 MAX_UNTRACKED_FILE_BYTES 与单文件过大折叠，
 *   尽量读全文（仍受总配额约束；二进制/产物强制无效）。
 * 返回处理后的文本 + 被忽略原因（若有）。
 */
function diffForUntracked(
  git: SimpleGit,
  repoPath: string,
  filePath: string,
  force = false
): Promise<ProcessedFile> {
  return (async () => {
    void git
    const { omit, reason } = classifyOmit(filePath)
    const header =
      `diff --git a/${filePath} b/${filePath}\n` +
      `new file mode 100644\n` +
      `--- /dev/null\n` +
      `+++ b/${filePath}\n`
    if (omit && reason) {
      return { text: header + omittedLine(reason), omitted: reason }
    }
    // 读文件内容（强制时放宽大小上限，否则带 64KB 上限）
    const abs = path.join(repoPath, filePath)
    const fs = await import('fs')
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      return { text: header + '[file not readable]\n', omitted: null }
    }
    if (!force && stat.size > MAX_UNTRACKED_FILE_BYTES) {
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
    // 检测是否包含 NUL 字节（典型二进制特征），有则折叠（强制也无效）
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
    // 走 processFileDiff 统一处理超长折叠（force 透传）
    return processFileDiff(block, filePath, force)
  })()
}

/**
 * 聚合 diff 供 AI 使用。
 * - 有暂存 → source='staged'，仅取 --cached diff
 * - 无暂存 → source='all'，取工作区已跟踪文件 diff + 未跟踪文件内容
 *
 * 总量上限固定按 128K token 上下文推算（见 MAX_TOTAL_CHARS），不再随模型变化。
 *
 * @param repoPath         仓库绝对路径
 * @param forceIncludePaths 用户指定「强制包含」的文件路径（优先占用配额、尽量发全文；二进制/产物除外）
 * @param onlyPaths        仅保留这些路径的改动（代码审查文件选择器选用）。
 *                         为空/未传 = 不过滤（全量，commit message 生成即此模式）。
 *                         source 判断不受影响：仍按「有暂存则 staged 否则 all」，
 *                         onlyPaths 只在确定 source 后对文件集做白名单过滤。
 */
export async function aggregateDiffForAi(
  repoPath: string,
  forceIncludePaths: string[] = [],
  onlyPaths: string[] = []
): Promise<DiffForAi> {
  const git: SimpleGit = simpleGit({ baseDir: repoPath, binary: 'git', maxConcurrentProcesses: 4 })
  const omitted: OmittedFile[] = []
  const maxTotal = MAX_TOTAL_CHARS
  const forceSet = new Set(forceIncludePaths)
  const onlySet = onlyPaths.length > 0 ? new Set(onlyPaths) : null

  // 1. 优先尝试暂存 diff
  const stagedRaw = await git.diff(['--cached'])
  if (stagedRaw.trim()) {
    const filtered = onlySet ? filterBlocksByPaths(stagedRaw, onlySet) : stagedRaw
    const { diff, truncated } = filterAggregatedDiff(filtered, omitted, maxTotal, forceIncludePaths)
    return { diff, truncated, omittedFiles: omitted, source: 'staged' }
  }

  // 2. 无暂存 → 全量工作区改动
  // 2a. 已跟踪文件的改动（modified/deleted，不含 untracked）
  const trackedRaw = await git.diff(['--']) // 默认不含未跟踪
  const parts: string[] = []
  let truncated = false
  let used = 0 // 已用配额（字符）
  if (trackedRaw.trim()) {
    const trackedFiltered = onlySet ? filterBlocksByPaths(trackedRaw, onlySet) : trackedRaw
    const r = filterAggregatedDiff(trackedFiltered, omitted, maxTotal, forceIncludePaths)
    parts.push(r.diff)
    truncated = truncated || r.truncated
    used += r.diff.length
  }

  // 2b. 未跟踪文件：用 git status 取列表，逐个生成内容 diff
  const st = await git.status()
  // onlyPaths 白名单过滤未跟踪文件
  const untrackedAll = st.not_added ?? []
  const untracked = onlySet ? untrackedAll.filter((f) => onlySet.has(f)) : untrackedAll

  // 收集每个未跟踪文件的处理结果（强制包含透传 force），再按三层优先级装填
  type UntrackedItem = {
    filePath: string
    processed: ProcessedFile
    order: number
    forced: boolean
    outText: string
    forceTruncNote: string | null
  }
  const untrackedItems: UntrackedItem[] = []
  for (const f of untracked) {
    const forced = forceSet.has(f)
    const processed = await diffForUntracked(git, repoPath, f, forced)
    untrackedItems.push({ filePath: f, processed, order: untrackedItems.length, forced, outText: processed.text, forceTruncNote: null })
  }

  const sizeLimitReason: Omit<OmittedFile, 'path'> = {
    reason: 'size_limit',
    note: '总量超限，内容已省略'
  }
  const forceTruncReason: Omit<OmittedFile, 'path'> = {
    reason: 'too_large',
    note: '已强制包含，因总量超限部分截断'
  }
  const keepSet = new Set<number>()

  // 第一优先：强制包含且未折叠的文件，优先占用剩余配额；装不下时部分截断
  for (const it of untrackedItems) {
    if (it.forced && !it.processed.omitted) {
      if (used + it.outText.length <= maxTotal) {
        keepSet.add(it.order)
        used += it.outText.length
      } else {
        const budget = maxTotal - used
        const headerLen =
          (`diff --git a/${it.filePath} b/${it.filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${it.filePath}\n`).length
        if (budget > headerLen + 64) {
          const { text } = truncateHunks(it.outText, budget)
          it.outText = text
          it.forceTruncNote = '已强制包含，因总量超限部分截断'
          keepSet.add(it.order)
          used += it.outText.length
        }
      }
    }
  }

  // 第二优先：折叠文件（占空间小，纳入以"告知存在"）
  for (const it of untrackedItems) {
    if (it.processed.omitted) {
      keepSet.add(it.order)
      used += it.outText.length
    }
  }

  // 第三优先：未折叠非强制文件按优先级排序后在剩余配额内装填
  const unfoldedUntracked = untrackedItems
    .filter((it) => !it.processed.omitted && !it.forced)
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
    if (used + it.outText.length > maxTotal) continue
    keepSet.add(it.order)
    used += it.outText.length
  }

  // 按原顺序输出未跟踪文件
  for (const it of untrackedItems) {
    if (keepSet.has(it.order)) {
      parts.push(it.outText)
      if (it.processed.omitted) {
        omitted.push({ path: it.filePath, ...it.processed.omitted })
      }
      if (it.forceTruncNote) {
        truncated = true
        omitted.push({ path: it.filePath, ...forceTruncReason })
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
