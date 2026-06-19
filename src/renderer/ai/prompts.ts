/**
 * AI 提交信息提示词构造
 * --------------------------------------------------
 * - DEFAULT_RULES：预设生成规则（与主进程 StoreService 中的默认值保持一致文本）
 * - buildMessages：根据 选中前缀 / 详细开关 / 改动来源，组装 [system, user] 消息
 *
 * 注意：DEFAULT_RULES 文本需与 src/main/services/StoreService.ts 中 DEFAULT_AI_RULES
 * 保持一致（两边都是 SSOT 的副本：主进程用于初始化持久化默认值，渲染进程用于"恢复默认"按钮的本地预览）。
 */
import type { AiMessage } from '@shared/index'

export const DEFAULT_RULES = `你是一名资深的 Git 提交信息撰写专家。请根据提供的代码差异（diff），生成一条简洁、准确的 commit message。

规则：
1. 遵循 Conventional Commits 规范，格式为：<type>(<scope>): <subject>。
2. type 从以下选取：feat / fix / docs / style / refactor / perf / test / build / ci / chore / revert。
3. subject 用中文，简明描述本次改动的目的（做了什么 / 为什么），不超过 50 字，句末不加句号。
4. scope 可选，表示改动范围（模块/组件名）；不确定时可省略。
5. 优先总结改动意图，不要逐行复述 diff。
6. 直接输出最终 commit message，不要任何解释、前言、代码块标记或多余空行。`

interface BuildOpts {
  /** 用户自定义规则文本（默认 DEFAULT_RULES） */
  rules: string
  /** 选中的前缀 label（如 feat / TASK#12345）；null 表示无前缀 */
  prefix: string | null
  /** 详细模式：true 则首行后追加 - 子项 */
  detailed: boolean
  /** 改动来源：暂存改动 or 全量改动 */
  source: 'staged' | 'all'
  /** 用户预填草稿（生成前手写的要点）；null/空 表示无 */
  userDraft: string | null
  /** 本次 diff 是否因体积过大被整体截断（true 时注入"仅基于已展示内容总结"提示） */
  truncated: boolean
}

export function buildSystem(opts: BuildOpts): string {
  const parts: string[] = [opts.rules]

  // 详细模式约束
  if (opts.detailed) {
    parts.push(
      '\n输出结构：首行为 subject（type(scope): 简述），空一行后，用 "- " 子项列出 2~5 条本次改动的关键点（具体做了什么）。子项同样用中文，每条不超过一行。'
    )
  } else {
    parts.push('\n输出结构：只输出一行 subject（type(scope): 简述），不要正文、不要子项、不要空行。')
  }

  // 前缀注入
  if (opts.prefix && opts.prefix.trim()) {
    parts.push(
      `\n前缀要求：提交信息首行必须以「${opts.prefix.trim()}」开头（例如 ${opts.prefix.trim()}: 描述，或 ${opts.prefix.trim()} 描述）。这是用户的强制约束，必须遵守。`
    )
  }

  // 改动来源说明
  if (opts.source === 'all') {
    parts.push(
      '\n注意：以下差异包含工作区所有未提交改动（未暂存 + 未跟踪），并非仅暂存内容。请据此总结本次整体改动。'
    )
  } else {
    parts.push('\n以下差异为已暂存（staged）的改动。')
  }

  // 截断告知：diff 因体积过大被裁剪，避免模型臆测未展示文件的改动
  if (opts.truncated) {
    parts.push(
      '\n注意：本次差异因体积较大被截断，仅包含部分文件（标记「内容已省略」的文件未展示具体改动）。' +
        '请仅基于已展示内容总结，不要臆测未展示文件的改动；可在 subject 末尾用「（等）」收尾。'
    )
  }

  return parts.join('')
}

export function buildUser(diff: string, userDraft: string | null): string {
  const lines: string[] = ['请根据下面的 git diff 生成 commit message：']
  if (userDraft && userDraft.trim()) {
    lines.push('')
    lines.push('我已写下一些要点，请在润色后融合进最终 commit message（可调整措辞、补全规范，但不要丢弃我的意图）：')
    lines.push('---')
    lines.push(userDraft.trim())
    lines.push('---')
  }
  lines.push('', '```diff', diff, '```')
  return lines.join('\n')
}

/** 组装完整消息序列 */
export function buildMessages(opts: BuildOpts, diff: string): AiMessage[] {
  return [
    { role: 'system', content: buildSystem(opts) },
    { role: 'user', content: buildUser(diff, opts.userDraft) }
  ]
}
