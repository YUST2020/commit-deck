/**
 * Markdown 渲染封装（代码审查结果展示用）
 * --------------------------------------------------
 * 选 markdown-it：默认 HTML 转义、安全、零运行时依赖、体积小。
 *
 * 安全策略：
 *   html:false —— 所有原始 HTML 被转义成文本显示，AI 输出经此处理无 XSS 风险
 *   （代码块里的 <script> 会被当作文本渲染，而非执行）。
 *   若将来放开 html:true，须额外接入 DOMPurify 做 sanitize。
 *
 * 分级着色：prompt 约束输出固定标题（「## 🔴 严重」「## 🟡 建议」「## 🔵 可选」）。
 * 通过覆盖 heading_open + inline 的渲染，给对应 h2 注入 data-severity 属性，
 * 供 CSS 按 [data-severity] 着色左竖条（比 :has 文本匹配更可靠、兼容性更好）。
 *
 * 单例：整个应用共用一个 markdown-it 实例（构造开销集中在首次调用，后续 render 为纯函数）。
 */
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

let instance: MarkdownIt | null = null

/** 根据标题纯文本判定严重级别，返回 severity 标识（无匹配返回 null） */
function detectSeverity(text: string): 'critical' | 'warning' | 'info' | null {
  if (text.includes('🔴')) return 'critical'
  if (text.includes('🟡')) return 'warning'
  if (text.includes('🔵')) return 'info'
  return null
}

function getInstance(): MarkdownIt {
  if (!instance) {
    const md = new MarkdownIt({
      html: false, // 转义原始 HTML，防止 XSS
      breaks: true, // 单换行渲染为 <br>（审查结果多为行文，更贴合直觉）
      linkify: true, // 自动识别 URL 为链接
      typographer: false
    })

    // 覆盖 heading_open：对 h2 读取其后 inline 子节点的文本，按 emoji 判定级别并打标
    const defaultHeadingOpen = md.renderer.rules.heading_open ||
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
      const openTok = tokens[idx]
      if (openTok.tag === 'h2') {
        // inline 子节点紧跟在 heading_open 之后
        const inlineTok: Token | undefined = tokens[idx + 1]
        if (inlineTok && inlineTok.type === 'inline') {
          const text = inlineTok.content || ''
          const sev = detectSeverity(text)
          if (sev) openTok.attrSet('data-severity', sev)
        }
      }
      return defaultHeadingOpen(tokens, idx, options, env, self)
    }

    instance = md
  }
  return instance
}

/** 将 Markdown 源文本渲染为 HTML 字符串（供 v-html 使用） */
export function renderMarkdown(src: string): string {
  if (!src) return ''
  return getInstance().render(src)
}

/** composable 风格入口（与项目其它 useXxx 保持一致；内部即单例 render） */
export function useMarkdown(): { render: (src: string) => string } {
  return { render: renderMarkdown }
}
