/**
 * AI 代码审查提示词构造
 * --------------------------------------------------
 * 复刻 ai/prompts.ts 的结构，但针对「代码审查」场景：
 * - DEFAULT_REVIEW_RULES：审查专家角色 + 审查维度（正确性/安全/性能/可读性/边界/错误处理）
 * - buildReviewMessages：组装 [system, user]，并约束输出为「总体评价 + 分级问题清单」的固定 Markdown 结构，
 *   便于 CodeReviewModal 直接用 Markdown 渲染承接。
 *
 * 注意：第一版审查规则硬编码（不持久化、不可编辑），与 prompts.ts 的「落盘 customRules」刻意区分；
 * 如需开放用户自定义，再在 AiPrefs 增 reviewRules 字段并迁移此处为 SSOT 副本。
 */
import type { AiMessage } from '@shared/index'

export const DEFAULT_REVIEW_RULES = `你是资深代码审查专家。审查下方 git diff，只针对本次改动，不审查既有代码。发现问题需可执行：指明文件与行号、给出具体改法，不泛泛而谈、不强行编造问题。`

interface ReviewBuildOpts {
  /** 改动来源：暂存改动 or 全量改动 */
  source: 'staged' | 'all'
  /** 本次 diff 是否因体积过大被整体截断（true 时注入"仅基于已展示内容审查"提示） */
  truncated: boolean
  /** 本次实际参与审查的文件数（用于约束总结篇幅） */
  fileCount?: number
}

/**
 * 输出结构约束：总体评价 + 三级问题清单，直接用 Markdown 承接渲染。
 * 精简要点（提速 + 减少啰嗦）：
 *   - 格式说明只写一次，不每级重复；
 *   - 每级硬上限条数，无问题直接省略该节（不输出「无」）；
 *   - 总评限句数。
 */
function buildOutputStructure(fileCount?: number): string {
  const scope = fileCount && fileCount > 0 ? `（共 ${fileCount} 个文件）` : ''
  return `
输出结构（Markdown，不要任何前言）：

## 总体评价
${scope}2~4 句：改动意图、整体质量、主要风险。不堆砌。

## 🔴 严重
会导致 bug / 安全漏洞 / 数据丢失的问题。最多 5 条，每条格式（文件名单独一行）：
- **文件:行号**
  问题。建议：改法。

## 🟡 建议
值得改进但不阻塞的问题（可读性/隐患/可维护性）。最多 5 条，格式同上。

## 🔵 可选
锦上添花的小优化（命名/注释/重构）。最多 3 条，格式同上。

规则：每条「文件:行号」必须独占一行（加粗），其下的问题描述缩进两格续行、限一行；某级别确无问题则整节省略；emoji 与标题文字必须原样输出。`
}

export function buildReviewSystem(opts: ReviewBuildOpts): string {
  const parts: string[] = [DEFAULT_REVIEW_RULES, buildOutputStructure(opts.fileCount)]

  // 改动来源说明（复刻 prompts.ts 的处理）
  if (opts.source === 'all') {
    parts.push(
      '\n注意：以下差异包含工作区所有未提交改动（未暂存 + 未跟踪），并非仅暂存内容。请据此审查本次整体改动。'
    )
  } else {
    parts.push('\n以下差异为已暂存（staged）的改动。')
  }

  // 截断告知：diff 因体积过大被裁剪，避免模型臆测未展示文件的改动
  if (opts.truncated) {
    parts.push(
      '\n注意：本次差异因体积较大被截断，仅包含部分文件（标记「内容已省略」的文件未展示具体改动）。' +
        '请仅基于已展示内容审查，不要臆测未展示文件的改动；可在总体评价中注明「部分文件未展示」。'
    )
  }

  return parts.join('')
}

export function buildReviewUser(diff: string): string {
  return ['审查下面的 git diff：', '', '```diff', diff, '```'].join('\n')
}

/** 组装完整消息序列 */
export function buildReviewMessages(opts: ReviewBuildOpts, diff: string): AiMessage[] {
  return [
    { role: 'system', content: buildReviewSystem(opts) },
    { role: 'user', content: buildReviewUser(diff) }
  ]
}
