/**
 * Markdown renderer with syntax highlighting, LaTeX (KaTeX) and Mermaid diagrams.
 *
 * Wraps react-markdown with:
 *   - remark-gfm (tables, task lists, strikethrough)
 *   - remark-math + rehype-katex (inline/block math)
 *   - rehype-raw (HTML tags support like mark, u, details, summary)
 *   - rehype-highlight (code syntax highlighting)
 *   - custom `code` component: mermaid blocks rendered as SVG via mermaid.render
 */
import React, { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
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
interface CodeProps extends ComponentPropsWithoutRef<'code'> {
  streaming?: boolean
}

function CodeComponent(props: CodeProps) {
  const { className, children, streaming, ...rest } = props
  const match = /language-(\w+)/.exec(className ?? '')
  const lang = match?.[1]
  const text = String(children)

  // Mermaid block: ```mermaid
  if (lang === 'mermaid') {
    if (streaming) {
      return (
        <pre className="chat-mermaid-raw" style={{ background: 'var(--agent-panel-alt, #fffef0)', padding: '12px', borderRadius: '6px', border: '1px solid var(--agent-border, #e6dfcc)', fontFamily: 'monospace' }}>
          <code>{text}</code>
        </pre>
      )
    }
    return <MermaidBlock chart={text.replace(/\n$/, '')} />
  }

  // Inline code (no language class and no newline) → default styling via rehype-highlight
  return <code className={className} {...rest}>{children}</code>
}

// Helper to parse basic inline markdown syntax inside HTML containers
function parseInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}


// Helper to preprocess markdown content into custom elements before rendering
function preprocessMarkdown(content: string): string {
  // Pre-process highlights (==text== -> <mark>text</mark>) and underlines (++text++ -> <u>text</u>)
  let processed = content
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\+\+([^+]+)\+\+/g, '<u>$1</u>')

  const lines = processed.split('\n')
  const result: string[] = []
  
  let inDl = false
  let inAdmonition = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    let line = rawLine.trim()
    let isBlockquote = false

    // Check and strip leading blockquote marker >
    if (line.startsWith('>')) {
      isBlockquote = true
      line = line.slice(1).trim()
    }

    // 1. If we are currently inside an Admonition content block
    if (inAdmonition) {
      if (isBlockquote && line !== '') {
        // Strip bold prefix to check if the next line is a new admonition header
        let nextTempLine = line
        if (nextTempLine.startsWith('**')) nextTempLine = nextTempLine.slice(2).trim()
        else if (nextTempLine.startsWith('__')) nextTempLine = nextTempLine.slice(2).trim()

        const nextCodePoint = nextTempLine.codePointAt(0)
        const isNextGitHubAlert = line.startsWith('[!') && line.includes(']')
        const isNextEmojiAlert = nextCodePoint === 9888 || nextCodePoint === 128161 || nextCodePoint === 128680 || nextCodePoint === 8505 || nextCodePoint === 128721 || nextCodePoint === 128204 || nextCodePoint === 128205
        
        if (isNextGitHubAlert || isNextEmojiAlert) {
          result.push('</div></div>')
          inAdmonition = false
          i-- // Reprocess this line as a new admonition header
          continue
        }
        
        result.push(line)
        continue
      } else {
        result.push('</div></div>')
        inAdmonition = false
        i-- // Reprocess this line normally
        continue
      }
    }

    // 2. Check for Admonition header: standard GitHub markdown alert [!NOTE]
    if (line.startsWith('[!') && line.includes(']')) {
      const alertMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line)
      if (alertMatch) {
        const type = alertMatch[1].toLowerCase()
        const contentRest = alertMatch[2]

        const alertIcon: Record<string, string> = {
          note: 'ℹ️',
          tip: '💡',
          important: '⚠️',
          warning: '🚨',
          caution: '🛑',
        }
        const alertTitle: Record<string, string> = {
          note: 'NOTE',
          tip: 'TIP',
          important: 'IMPORTANT',
          warning: 'WARNING',
          caution: 'CAUTION',
        }

        result.push(`<div class="admonition admonition-${type}">`)
        result.push(`<div class="admonition-title"><span class="admonition-icon">${alertIcon[type]}</span>${alertTitle[type]}</div>`)
        result.push('<div class="admonition-content">')
        if (contentRest) {
          result.push(contentRest)
        }
        inAdmonition = true
        continue
      }
    }

    // 3. Check for Admonition header: Emoji prefixed warning (potentially wrapped in bold tags)
    let tempLine = line
    let isBoldPrefix = false
    
    if (tempLine.startsWith('**')) {
      tempLine = tempLine.slice(2).trim()
      isBoldPrefix = true
    } else if (tempLine.startsWith('__')) {
      tempLine = tempLine.slice(2).trim()
      isBoldPrefix = true
    }

    const codePoint = tempLine.codePointAt(0)
    let emojiType = ''
    let emojiIcon = ''
    let emojiTitle = ''

    if (codePoint === 9888) { emojiType = 'important'; emojiIcon = '⚠️'; emojiTitle = '重要' }
    else if (codePoint === 128161) { emojiType = 'tip'; emojiIcon = '💡'; emojiTitle = '提示' }
    else if (codePoint === 128680) { emojiType = 'warning'; emojiIcon = '🚨'; emojiTitle = '警告' }
    else if (codePoint === 8505) { emojiType = 'note'; emojiIcon = 'ℹ️'; emojiTitle = '注意' }
    else if (codePoint === 128721) { emojiType = 'caution'; emojiIcon = '🛑'; emojiTitle = '危险' }
    else if (codePoint === 128204) { emojiType = 'tip'; emojiIcon = '📌'; emojiTitle = '提醒' }
    else if (codePoint === 128205) { emojiType = 'tip'; emojiIcon = '📍'; emojiTitle = '提醒' }

    if (emojiType) {
      let emojiLength = 1
      if (codePoint > 0xffff) {
        emojiLength = 2
      }
      if (tempLine.charCodeAt(emojiLength) === 65039) {
        emojiLength++
      }
      const rest = tempLine.slice(emojiLength).trim()
      
      // Match suffix like "注意：**", "注意**：", "注意：", "注意**", "注意:"
      const labelMatch = /^(注意|提示|危险|警告|重要|提醒)\s*(\*\*|__)?\s*[：:]?\s*(\*\*|__)?\s*(.*)$/.exec(rest)

      let customTitle = emojiTitle
      let contentRest = rest
      if (labelMatch) {
        customTitle = labelMatch[1]
        contentRest = labelMatch[4] || ''
      }

      // If the contentRest ends with the matching bold tags, strip them too
      if (isBoldPrefix && contentRest.endsWith('**')) {
        contentRest = contentRest.slice(0, -2).trim()
      } else if (isBoldPrefix && contentRest.endsWith('__')) {
        contentRest = contentRest.slice(0, -2).trim()
      }

      result.push(`<div class="admonition admonition-${emojiType}">`)
      result.push(`<div class="admonition-title"><span class="admonition-icon">${emojiIcon}</span>${customTitle}</div>`)
      result.push('<div class="admonition-content">')
      if (contentRest) {
        result.push(contentRest)
      }
      inAdmonition = true
      continue
    }

    // 4. Check for Definition List
    let nextLineRaw = lines[i + 1]
    let nextLine = nextLineRaw ? nextLineRaw.trim() : ''
    if (nextLine.startsWith('>')) {
      nextLine = nextLine.slice(1).trim()
    }

    const isCurrentTerm = (line.startsWith('**') && line.endsWith('**') && line.length < 60) || 
                          (line.startsWith('__') && line.endsWith('__') && line.length < 60)

    if (isCurrentTerm && nextLine !== '' && !nextLine.startsWith('#') && !nextLine.startsWith('-') && !nextLine.startsWith('*') && !nextLine.startsWith('>')) {
      if (!inDl) {
        result.push('<dl>')
        inDl = true
      }
      const termText = line.slice(2, -2).trim()
      result.push(`<dt>${parseInlineMarkdown(termText)}</dt>`)
      result.push(`<dd>${parseInlineMarkdown(nextLine)}</dd>`)
      i++ // Skip the next line as it is consumed as definition
      continue
    }

    if (nextLine && nextLine.startsWith(':')) {
      if (!inDl) {
        result.push('<dl>')
        inDl = true
      }
      result.push(`<dt>${parseInlineMarkdown(line)}</dt>`)
    } else if (line.startsWith(':')) {
      if (!inDl) {
        result.push('<dl>')
        inDl = true
      }
      const defContent = line.slice(1).trim()
      result.push(`<dd>${parseInlineMarkdown(defContent)}</dd>`)
    } else {
      if (inDl) {
        result.push('</dl>')
        inDl = false
      }
      // Re-assemble standard blockquote format if it wasn't captured as an admonition
      result.push(isBlockquote ? `> ${line}` : rawLine)
    }
  }

  if (inDl) {
    result.push('</dl>')
  }
  if (inAdmonition) {
    result.push('</div></div>')
  }

  return result.join('\n')
}

// ─────────────────────────────────────────────
// Main renderer
// ─────────────────────────────────────────────
interface Props {
  content: string
  streaming?: boolean
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, streaming = false }: Props) {
  const processed = preprocessMarkdown(content)

  return (
    <div className="markdown-renderer-container">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex, rehypeHighlight]}
        components={{ 
          code: (props) => <CodeComponent {...props} streaming={streaming} />
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
})
