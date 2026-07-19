/**
 * Git 服务（基于 simple-git）
 * 封装项目目录下的 git 读取与操作。
 * 凭证复用系统 git（SSH key / Git Credential Manager）。
 */
import path from 'path'
import fs from 'fs'
import simpleGit, { type SimpleGit } from 'simple-git'
import type { BranchInfo, ChangedFileInfo, ChangedFilesForReview, FileChange, FileStatus, GitSyncResult, LogEntry } from '@shared/index'
import { classifyOmit } from './DiffAggregator'

/** 为指定目录创建 git 实例（带基础超时与错误容忍） */
function gitOf(repoPath: string): SimpleGit {
  return simpleGit({
    baseDir: repoPath,
    binary: 'git',
    maxConcurrentProcesses: 4,
    trimmed: false
  })
}

/** 校验目录是否存在且是 git 仓库 */
export async function checkIsRepo(repoPath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(repoPath)) return false
    const git = gitOf(repoPath)
    return await git.checkIsRepo()
  } catch {
    return false
  }
}

/** 取目录名作为默认项目显示名 */
export function dirName(repoPath: string): string {
  return path.basename(repoPath) || repoPath
}

/**
 * 还原 git 输出路径的 C 风格转义（core.quotepath=true 时中文等非 ASCII 路径会被转义）。
 *
 * git 对含「不安全」字符（空格以外的控制字符、非 ASCII 字节、双引号、反斜杠等）的路径，
 * 会用双引号包裹并对每个字节做八进制转义：如「详细」→ `"\350\257\246\347\273\206"`。
 * 此函数还原为真实 UTF-8 字符串，使 UI 能正确显示中文文件名。
 *
 * 规则（与 git quote.c 一致）：
 *   - 仅当字符串以双引号开始且以双引号结束才视为已转义，剥去首尾引号后逐字节解析；
 *   - `\nnn` 八进制（1~3 位）→ 对应字节；
 *   - `\n \t \r \" \\` 等常规转义 → 还原字符；
 *   - `\xNN` 十六进制（git 较新版本可能输出）→ 对应字节；
 *   - 其余字符按原字节保留。
 *   - 不以双引号包裹的路径视为普通 ASCII 路径，原样返回（零副作用）。
 */
function decodeGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw
  }
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0) & 0xff)
      i++
      continue
    }
    const next = body[i + 1]
    // 常规转义
    switch (next) {
      case 'n':
        bytes.push(0x0a); i += 2; continue
      case 't':
        bytes.push(0x09); i += 2; continue
      case 'r':
        bytes.push(0x0d); i += 2; continue
      case 'b':
        bytes.push(0x08); i += 2; continue
      case 'f':
        bytes.push(0x0c); i += 2; continue
      case 'v':
        bytes.push(0x0b); i += 2; continue
      case 'a':
        bytes.push(0x07); i += 2; continue
      case '"':
        bytes.push(0x22); i += 2; continue
      case '\\':
        bytes.push(0x5c); i += 2; continue
      case '0': case '1': case '2': case '3':
      case '4': case '5': case '6': case '7': {
        // 八进制：1~3 位
        let oct = ''
        let j = i + 1
        while (j < body.length && oct.length < 3 && /^[0-7]$/.test(body[j])) {
          oct += body[j]; j++
        }
        bytes.push(parseInt(oct, 8) & 0xff); i = j; continue
      }
      case 'x': {
        // 十六进制 \xNN
        const hex = body.slice(i + 2, i + 4)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16) & 0xff); i += 4; continue
        }
        bytes.push(next.charCodeAt(0) & 0xff); i += 2; continue
      }
      default:
        // 未知转义：保留反斜杠后的字符
        bytes.push(next.charCodeAt(0) & 0xff); i += 2; continue
    }
  }
  // 字节数组 → UTF-8 字符串
  try {
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return body
  }
}

/** 把 git status 的原始状态码映射为语义 FileStatus */
function mapStatus(code: string, isStaged: boolean): FileStatus {
  const indexCode = code[0] // 暂存区状态码（X）
  const wtCode = code[1] // 工作区状态码（Y）

  // 优先看是否已暂存（indexCode 不为空格/问号）
  if (isStaged) {
    if (indexCode === 'A') return 'added'
    if (indexCode === 'D') return 'deleted'
    if (indexCode === 'R') return 'renamed'
    return 'modified'
  }
  // 工作区态
  if (wtCode === '?' || indexCode === '?') return 'untracked'
  if (wtCode === 'D') return 'deleted'
  return 'modified'
}

/**
 * 获取工作区文件变更（含暂存/未暂存两态）。
 * simple-git 的 FileStatusResult 字段为 index(X) 与 working_dir(Y)。
 */
export async function getStatus(repoPath: string): Promise<FileChange[]> {
  const git = gitOf(repoPath)
  const st = await git.status()
  const changes: FileChange[] = []

  for (const f of st.files) {
    const code = `${f.index}${f.working_dir}` // 形如 ' M' / 'M ' / 'A ' / '??'
    const indexCode = code[0]
    const wtCode = code[1]
    const isStagedInIndex = indexCode !== ' ' && indexCode !== '?'
    // simple-git 返回的 f.path / f.from 是 git 原始输出，中文路径会被八进制转义
    // （core.quotepath），这里统一还原为真实 UTF-8 字符串，确保 UI 正确显示中文
    const realPath = decodeGitPath(f.path)
    const realFrom = f.from ? decodeGitPath(f.from) : ''
    const displayPath = realFrom ? `${realFrom} → ${realPath}` : realPath

    // 已暂存版本（index 与 HEAD 有差异）
    if (isStagedInIndex) {
      changes.push({ path: displayPath, status: mapStatus(code, true), staged: true })
    }
    // 工作区版本（index 与工作树有差异，或未跟踪）
    if (wtCode === '?') {
      changes.push({ path: realPath, status: 'untracked', staged: false })
    } else if (wtCode !== ' ' && wtCode !== indexCode) {
      changes.push({ path: realPath, status: mapStatus(code, false), staged: false })
    }
  }
  return changes
}

/**
 * 代码审查文件选择器取数：列出当前可审查的改动文件。
 *
 * 与 aggregateDiffForAi 同源判断：有暂存 → source='staged'（仅暂存文件）；
 * 无暂存 → source='all'（工作区已跟踪改动 + 未跟踪文件）。
 * 这样选择器展示的文件集合与实际聚合审查的 diff 来源完全一致。
 *
 * 每个文件用 classifyOmit（与 DiffAggregator 同一规则）判定内容是否会被折叠：
 * contentOmitted=true 的文件（二进制/产物/锁）在选择器中应禁用勾选——
 * 勾选也无意义（内容会被省略）。reason 给出用于选择器徽标文案。
 */
export async function listChangedFilesForReview(
  repoPath: string
): Promise<ChangedFilesForReview> {
  const git = gitOf(repoPath)

  // 同源判断：有暂存内容则审查暂存，否则审查全量
  const stagedDiff = await git.diff(['--cached'])
  const hasStaged = stagedDiff.trim().length > 0

  if (hasStaged) {
    const files = await collectFromNameStatus(git, ['--cached'])
    return { source: 'staged', files: annotateOmit(files, true) }
  }

  // 无暂存：已跟踪改动（--name-status）+ 未跟踪文件
  const tracked = await collectFromNameStatus(git, [])
  const st = await git.status()
  // st.not_added 同样来自 git status 原始输出，中文路径会被八进制转义，需还原
  const untracked = (st.not_added ?? []).map(decodeGitPath)
  const all: Array<{ path: string; status: FileStatus }> = [
    ...tracked,
    ...untracked.map((p) => ({ path: p, status: 'untracked' as FileStatus }))
  ]
  return { source: 'all', files: annotateOmit(all, false) }
}

/**
 * 用 git diff --name-status 取文件列表，解析状态码映射为 FileStatus。
 * @param opts 额外的 git diff 选项（如 ['--cached'] 取暂存）。
 *
 * 注意：--name-status 必须放在 opts 之前。若 opts 含 '--'（路径分隔符），
 * 其后的 --name-status 会被 git 当作 pathspec（不存在的路径）→ 返回空。
 * 故这里固定为 ['--name-status', ...opts]，保证选项在前。
 */
async function collectFromNameStatus(
  git: SimpleGit,
  opts: string[]
): Promise<Array<{ path: string; status: FileStatus }>> {
  const raw = await git.diff(['--name-status', ...opts])
  const out: Array<{ path: string; status: FileStatus }> = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    // 状态码与路径以制表符分隔；重命名/拷贝格式为 R100\told\tnew，取新路径
    const parts = t.split('\t')
    const code = parts[0]
    if (!code) continue
    const filePathRaw = parts.length >= 3 ? parts[parts.length - 1] : parts[1] ?? ''
    if (!filePathRaw) continue
    // git --name-status 对中文等非 ASCII 路径会做八进制转义（core.quotepath），还原真实路径
    out.push({ path: decodeGitPath(filePathRaw), status: nameStatusToFileStatus(code) })
  }
  return out
}

/** git --name-status 状态码 → FileStatus */
function nameStatusToFileStatus(code: string): FileStatus {
  const c = code[0]
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'R' || c === 'C') return 'renamed'
  return 'modified'
}

/** 给文件列表补上 contentOmitted / omitReason（复用 DiffAggregator 规则） */
function annotateOmit(
  files: Array<{ path: string; status: FileStatus }>,
  staged: boolean
): ChangedFileInfo[] {
  return files.map((f) => {
    const { omit, reason } = classifyOmit(f.path)
    let omitReason: 'binary' | 'generated' | undefined
    if (omit && reason) {
      omitReason = reason.reason === 'binary' ? 'binary' : 'generated'
    }
    return {
      path: f.path,
      status: f.status,
      staged,
      contentOmitted: omit,
      omitReason
    }
  })
}

/** 获取提交历史 */
export async function getLog(
  repoPath: string,
  maxCount = 50
): Promise<LogEntry[]> {
  const git = gitOf(repoPath)
  try {
    const log = await git.log({ maxCount })

    // 判定每个提交是否已推送：取「上游分支可达的完整 commit hash 集合」，
    // 本地 log 中的 hash 命中该集合即视为已推送。
    //
    // 旧实现用 git.log({ rev: upstreamHash }) 构造集合，simple-git 在带 rev 时
    // 对返回结构的解析不可靠（可能返回空或 hash 不匹配）→ 全部误判为未推送。
    // 改用 git.raw(['rev-list', <upstream>]) 直接拿每行一个完整 SHA，格式与
    // 本地 log.hash（完整 40 位）完全一致，集合匹配必然准确。
    const pushedSet = new Set<string>()
    let hasUpstream = false
    try {
      // rev-parse 取上游确切 hash；无上游（未 push -u 过）会抛错
      const upstreamHash = (await git.revparse(['@{u}'])).trim()
      if (upstreamHash) {
        hasUpstream = true
        // rev-list 列出从该 hash 可达的全部提交（每行一个完整 SHA）
        const out = await git.raw(['rev-list', upstreamHash])
        for (const line of out.split('\n')) {
          const h = line.trim()
          if (h) pushedSet.add(h)
        }
      }
    } catch {
      // 无上游分支（未 push -u 过）：全部视为未推送
      hasUpstream = false
    }

    return log.all.map((c) => ({
      hash: c.hash,
      hashShort: c.hash.slice(0, 7),
      author: c.author_name,
      date: c.date,
      message: c.message,
      pushed: hasUpstream ? pushedSet.has(c.hash) : false
    }))
  } catch {
    // 空仓库（尚无提交）会抛错，返回空数组
    return []
  }
}

/** 获取当前分支与 ahead/behind */
export async function getBranch(repoPath: string): Promise<BranchInfo | null> {
  const git = gitOf(repoPath)
  try {
    const st = await git.status()
    return {
      current: st.current || 'HEAD',
      tracking: st.tracking || null,
      ahead: st.ahead,
      behind: st.behind
    }
  } catch {
    return null
  }
}

/** 执行 git fetch 更新远程追踪分支状态 */
export async function fetch(repoPath: string): Promise<void> {
  const git = gitOf(repoPath)
  try {
    // 仅 fetch 当前分支的上游，避免全量 fetch 过慢
    const st = await git.status()
    if (st.tracking) {
      const remote = st.tracking.split('/')[0] || 'origin'
      await git.fetch(remote, st.current!)
    } else {
      // 无上游时尝试 fetch origin（兜底）
      await git.fetch(['--prune'])
    }
  } catch {
    // fetch 失败（如无网络）不阻断后续操作
  }
}

/** 获取单文件 diff（工作区态或暂存态） */
export async function getDiffFile(
  repoPath: string,
  file: string,
  staged: boolean
): Promise<string> {
  const git = gitOf(repoPath)
  if (staged) {
    return git.diff(['--cached', '--', file])
  }
  return git.diff(['--', file])
}

/** 获取整体暂存 diff（喂给 AI 的核心输入） */
export async function getDiffStaged(repoPath: string): Promise<string> {
  const git = gitOf(repoPath)
  return git.diff(['--cached'])
}

/** 暂存文件 */
export async function addFiles(
  repoPath: string,
  files: string[]
): Promise<void> {
  const git = gitOf(repoPath)
  await git.add(files)
}

/** 取消暂存 */
export async function resetFiles(
  repoPath: string,
  files: string[]
): Promise<void> {
  const git = gitOf(repoPath)
  await git.reset(['--', ...files])
}

/** 提交（message 支持多行），返回 commit hash */
export async function commit(repoPath: string, message: string): Promise<string> {
  const git = gitOf(repoPath)
  const res = await git.commit(message)
  // simple-git CommitResult.commit 为本次提交的 hash
  const hash: string = (res as { commit?: string }).commit ?? ''
  return hash
}

/**
 * 推送到上游。
 *
 * 三种场景处理（按需求）：
 *   1. 远端无其它 commit → fast-forward，直接推送成功；
 *   2. 远端有 commit 但无冲突 → push 被拒后自动 `pull --rebase`，rebase 成功则重试 push；
 *   3. 远端有冲突 → rebase 产生冲突时自动 `git rebase --abort` 回退，返回 conflict_aborted，
 *      由 UI 弹窗提示用户到其他 Git 工具解决冲突。
 *
 * 网络错误、无上游、其它未知错误均归类为对应 code，由 UI 分支弹窗。
 * 凭证复用系统 git（SSH key / GCM）。
 *
 * 实现说明：不用 simple-git 的 `git.push()`（它把错误塞进不统一的字段，难以可靠分类），
 * 改用 `git.raw(['push', ...])` 直接执行，自己解析原始 stdout/stderr + 退出码。
 */
export async function push(repoPath: string): Promise<GitSyncResult> {
  const git = gitOf(repoPath)
  const st = await git.status()
  const branch = st.current
  const tracking = st.tracking
  if (!branch) {
    return { result: 'unknown', message: '无法确定当前分支' }
  }
  if (!tracking) {
    return {
      result: 'no_upstream',
      branch,
      message: `当前分支「${branch}」没有设置上游。请在终端执行：git push -u origin ${branch}（首次推送需配置凭证）`
    }
  }
  const remote = tracking.split('/')[0] || 'origin'

  // 1. 直接尝试推送（覆盖远端无新提交 / fast-forward 场景）
  const r1 = await rawPush(git, remote, branch)
  if (r1.ok) return { result: 'pushed', remote, branch }

  const cls = r1.classification
  // 非 non-fast-forward 的失败（网络/认证/未知）直接返回，不重试
  if (cls !== 'rejected') {
    return { result: cls, remote, branch, message: syncErrorMessage(cls) }
  }

  // 2. non-fast-forward：自动 pull --rebase 合并远端改动
  const pullRes = await pullInternal(git, remote, branch)
  if (pullRes === 'conflict_aborted') {
    return { result: 'conflict_aborted', remote, branch, message: syncConflictMessage() }
  }
  if (pullRes !== 'fast_forwarded' && pullRes !== 'up_to_date') {
    return { result: pullRes, remote, branch, message: syncErrorMessage(pullRes) }
  }

  // 3. rebase 成功，重试推送
  const r2 = await rawPush(git, remote, branch)
  if (r2.ok) return { result: 'pushed', remote, branch }
  return { result: r2.classification, remote, branch, message: syncErrorMessage(r2.classification) }
}

/**
 * 用 git.raw 直接执行 push，返回结构化结果。
 * 比 simple-git 的 git.push() 更可控：能拿到完整的原始 stdout/stderr 做关键字分类，
 * 不依赖 simple-git 内部把错误塞到哪个字段。
 */
async function rawPush(
  git: SimpleGit,
  remote: string,
  branch: string
): Promise<{ ok: boolean; classification: GitSyncResult['result'] }> {
  try {
    await git.raw(['push', remote, branch])
    return { ok: true, classification: 'pushed' }
  } catch (e) {
    return { ok: false, classification: classifySyncError(e) }
  }
}

/**
 * 拉取远端（`git pull --rebase`）。
 * - 已是最新 → up_to_date；
 * - rebase 成功 → fast_forwarded；
 * - 产生冲突 → 自动 `git rebase --abort` 回退 → conflict_aborted。
 *
 * 冲突时**不保留 rebase 中间态**（按既定决策自动 abort），仓库回到拉取前的干净状态，
 * 用户可在其他 Git 工具中解决冲突后再次操作。
 */
export async function pull(repoPath: string): Promise<GitSyncResult> {
  const git = gitOf(repoPath)
  const st = await git.status()
  const branch = st.current
  const tracking = st.tracking
  if (!branch) {
    return { result: 'unknown', message: '无法确定当前分支' }
  }
  if (!tracking) {
    return {
      result: 'no_upstream',
      branch,
      message: `当前分支「${branch}」没有设置上游。请在终端执行：git push -u origin ${branch}（首次推送需配置凭证）`
    }
  }
  const remote = tracking.split('/')[0] || 'origin'

  const r = await pullInternal(git, remote, branch)
  if (r === 'conflict_aborted') {
    return { result: 'conflict_aborted', remote, branch, message: syncConflictMessage() }
  }
  if (r === 'fast_forwarded') {
    return { result: 'fast_forwarded', remote, branch }
  }
  if (r === 'up_to_date') {
    return { result: 'up_to_date', remote, branch }
  }
  return { result: r, remote, branch, message: syncErrorMessage(r) }
}

/**
 * 拉取内部实现：执行 pull --rebase 并处理冲突。
 * @returns fast_forwarded / up_to_date / conflict_aborted / 或一个错误 code（network/unknown）
 *
 * 实现说明：用 git.raw(['pull','--rebase',...]) 直接执行而非 simple-git 的 git.pull()，
 * 后者把冲突当作 resolve（不抛错）且 PullResult 结构不统一，难以可靠判定。
 * 直接用 raw + status.conflicted 双重判定最稳：
 *   - raw 抛错且关键字含 conflict → 冲突；
 *   - raw 不抛错但 status.conflicted 非空 → 冲突（rebase 卡住）；
 *   - 其余按 beforeBehind 判定 fast_forwarded / up_to_date。
 */
async function pullInternal(
  git: SimpleGit,
  remote: string,
  branch: string
): Promise<'fast_forwarded' | 'up_to_date' | 'conflict_aborted' | GitSyncResult['result']> {
  // 拉取前的 behind 值：用于区分「真有更新」与「已是最新」
  const before = await git.status()
  const beforeBehind = before.behind

  let pullError: unknown = null
  try {
    await git.raw(['pull', '--rebase', remote, branch])
  } catch (e) {
    pullError = e
    // 抛错时先分类：网络/未知直接返回；rejected/conflict 走下方冲突检查
    const cls = classifySyncError(e)
    if (cls === 'network' || cls === 'unknown') {
      return cls
    }
    // cls === 'rejected' 或 'conflict_aborted'：可能是冲突，统一进入冲突检查
  }

  // 冲突检测：rebase 产生冲突时 status.conflicted 必然非空（无论是否抛错）
  const after = await git.status()
  if (after.conflicted && after.conflicted.length > 0) {
    // 产生冲突：自动 abort 回退到 rebase 前的干净状态
    try {
      await git.raw(['rebase', '--abort'])
    } catch {
      // 不在 rebase 中（例如 merge 冲突），尝试 merge --abort 兜底
      try {
        await git.raw(['merge', '--abort'])
      } catch {
        /* 忽略：已无操作可中止 */
      }
    }
    return 'conflict_aborted'
  }

  // pull 抛了错但没冲突、也不是网络/未知：归为 unknown
  if (pullError) {
    return 'unknown'
  }

  // 无冲突：判断是否真的有更新
  // beforeBehind>0 表示拉取前远端领先 → 拉取后有变化即 fast_forwarded
  if (beforeBehind > 0) return 'fast_forwarded'
  return 'up_to_date'
}

/**
 * 识别 push/pull 失败的原因分类。
 *
 * simple-git 失败时抛出的错误对象字段不统一：
 *   - `GitError`（基础）：错误文本在 `message`；
 *   - `GitResponseError`：解析后的结构化结果在 `.git`（PushResult / PullResult），message 只是简述；
 *   - 进程级错误：可能只有 `stderr` / `stack`。
 *
 * 故把所有可能含 git 输出的字段拼起来一起做关键字匹配，避免漏判。
 */
function classifySyncError(e: unknown): GitSyncResult['result'] {
  // 收集所有可能含 git 输出文本的字段
  const parts: string[] = []
  const collect = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v)
    else if (v && typeof v === 'object') {
      // 避免无限递归 / 循环引用，只取一层常见字段
      const o = v as Record<string, unknown>
      for (const k of ['message', 'stderr', 'stdErr', 'raw', 'stack', 'hint']) {
        if (typeof o[k] === 'string') parts.push(o[k] as string)
      }
      // GitResponseError.git：push 时是 PushResult（含 pushed[]），pull 时是 PullResult
      // 这些结构里没有 rejected 关键字，跳过；但保险起见 stringify 一次
      if (o.git && typeof o.git === 'object') {
        try {
          parts.push(JSON.stringify(o.git))
        } catch {
          /* 忽略循环引用 */
        }
      }
    }
  }
  collect(e)
  // Error 实例的 message 一定在 e.message（上面已收），再兜底 String(e)
  parts.push(String(e ?? ''))
  const text = parts.join('\n').toLowerCase()
  if (!text.trim()) return 'unknown'

  // 冲突（CONFLICT / content conflict / merge conflict）
  if (text.includes('conflict') || text.includes('conflit')) {
    return 'conflict_aborted'
  }
  // non-fast-forward / rejected（push 被拒，或 pull rebase 失败需重试）
  // 关键字来源：git push 输出 `[rejected] (fetch first)` / `Updates were rejected`
  if (
    text.includes('non-fast-forward') ||
    text.includes('non fast forward') ||
    text.includes('[rejected]') ||
    text.includes('(fetch first)') ||
    text.includes('updates were rejected') ||
    text.includes('would be overwritten by merge')
  ) {
    return 'rejected'
  }
  // 网络 / 认证 / 权限
  if (
    text.includes('could not resolve host') ||
    text.includes('connection timed out') ||
    text.includes('failed to connect') ||
    text.includes('network is unreachable') ||
    text.includes('authentication failed') ||
    text.includes('permission denied') ||
    text.includes('access denied') ||
    text.includes('403') ||
    text.includes('401') ||
    text.includes('fatal: could not read') // 凭证读取失败
  ) {
    return 'network'
  }
  return 'unknown'
}

/** 把错误 code 映射为友好的中文文案（不含 conflict，它有专用文案） */
function syncErrorMessage(code: GitSyncResult['result']): string {
  switch (code) {
    case 'no_upstream':
      return '当前分支没有设置上游。请在终端执行 git push -u origin <分支> 配置首次推送与凭证。'
    case 'network':
      return '网络或认证失败：无法连接远端或凭证无效。请检查网络与 Git 凭证后重试。'
    case 'rejected':
      return '推送被远端拒绝（non-fast-forward）。请先拉取远端改动后再推送。'
    default:
      return '操作失败，请重试或查看终端日志。'
  }
}

/** 冲突专用文案（推送/拉取共用） */
function syncConflictMessage(): string {
  return '与远端存在冲突，已自动回退到操作前的状态。请在其他 Git 管理工具中解决冲突后再推送或拉取。'
}

/**
 * 撤回最近 N 个本地未推送的提交（git reset --soft HEAD~N）。
 * 仅软重置：提交被撤销，但改动保留在暂存区，可重新提交，安全可逆。
 * 校验：撤回数量不超过本地领先上游的提交数（ahead），避免撤回已推送的提交。
 * 无上游时，撤回数量不超过当前历史长度。
 */
export async function undoCommit(repoPath: string, count: number): Promise<void> {
  const n = Math.max(1, Math.floor(count))
  const git = gitOf(repoPath)
  const st = await git.status()

  // 计算可撤回的上限
  let maxUndo: number
  if (st.tracking) {
    // 有上游：最多撤回到上游位置（ahead 个）
    maxUndo = st.ahead
  } else {
    // 无上游：最多撤回到仓库初始提交之前（全部本地提交）
    // 用 rev-list 统计当前 HEAD 可达的提交数作为上限
    try {
      const countStr = await git.raw(['rev-list', '--count', 'HEAD'])
      maxUndo = parseInt(countStr.trim(), 10) || 0
    } catch {
      maxUndo = 0
    }
  }

  if (n > maxUndo) {
    throw new Error(
      st.tracking
        ? `只能撤回 ${maxUndo} 个未推送的提交（当前领先上游 ${maxUndo} 个）`
        : `只能撤回 ${maxUndo} 个提交`
    )
  }

  // soft reset：保留改动到暂存区
  await git.reset(['--soft', `HEAD~${n}`])
}
