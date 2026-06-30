/**
 * Markdown renderer with syntax highlighting, LaTeX (KaTeX) and Mermaid diagrams.
 *
 * Wraps react-markdown with:
 *   - remark-gfm (tables, task lists, strikethrough)
 *   - remark-math + rehype-katex (inline/block math)
 *   - rehype-highlight (code syntax highlighting)
 *   - custom `code` component: mermaid blocks rendered as SVG via mermaid.render
 */
import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import mermaid from 'mermaid'
// Syntax highlighting theme (github-light matches warm-pixel bg) + KaTeX math styles
import 'highlight.js/styles/github.css'
import 'katex/dist/katex.min.css'

// Initialize mermaid once with warm-pixel theme aligned to --agent-* tokens
let mermaidReady = false
function ensureMermaid() {
  if (mermaidReady) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      primaryColor: '#fff8e7',
      primaryTextColor: '#3a2a1a',
      primaryBorderColor: '#c0733a',
      lineColor: '#8b7a5d',
      secondaryColor: '#fffef7',
      tertiaryColor: '#f7f5ef',
      background: '#fffef7',
      mainBkg: '#fff8e7',
      nodeBorder: '#c0733a',
      clusterBkg: '#fffef0',
      clusterBorder: '#d6cdb6',
      edgeLabelBackground: '#fffef7',
      fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
    },
    securityLevel: 'loose',
  })
  mermaidReady = true
}

// ─────────────────────────────────────────────
// Mermaid block: async render to SVG
// ─────────────────────────────────────────────
let _mermaidSeq = 0
const MermaidBlock = memo(function MermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef(`mermaid-${++_mermaidSeq}`)

  useEffect(() => {
    let cancelled = false
    ensureMermaid()
    // mermaid.render returns { svg, bindFunctions } in v11
    mermaid.render(idRef.current, chart).then(
      ({ svg }) => { if (!cancelled) { setSvg(svg); setError(null) } },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) },
    )
    return () => { cancelled = true }
  }, [chart])

  if (error) {
    return (
      <pre className="chat-mermaid-error" title={error}>
        {`Mermaid 渲染失败：${error}\n\n${chart}`}
      </pre>
    )
  }
  if (!svg) {
    return <div className="chat-mermaid-loading">⏳ 渲染图表中...</div>
  }
  // dangerouslySetInnerHTML: mermaid.render output is trusted SVG markup
  return <div className="chat-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
})

// ─────────────────────────────────────────────
// Custom code component: detect mermaid / inline vs block
// ─────────────────────────────────────────────
function CodeComponent(props: ComponentPropsWithoutRef<'code'>) {
  const { className, children, ...rest } = props
  const match = /language-(\w+)/.exec(className ?? '')
  const lang = match?.[1]
  const text = String(children)

  // Mermaid block: ```mermaid
  if (lang === 'mermaid') {
    return <MermaidBlock chart={text.replace(/\n$/, '')} />
  }

  // Inline code (no language class and no newline) → default styling via rehype-highlight
  return <code className={className} {...rest}>{children}</code>
}

// ─────────────────────────────────────────────
// Main renderer
// ─────────────────────────────────────────────
interface Props {
  content: string
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      components={{ code: CodeComponent }}
    >
      {content}
    </ReactMarkdown>
  )
})
