/**
 * AI 快速对话窗口
 *
 * 功能：
 *  - 多轮对话（保留上下文 messages）
 *  - 流式输出：订阅 main:ai-chat-chunk，实时刷新当前 assistant 消息
 *  - 思考块（reasoning）以可折叠卡片展示，默认流式中展开、完成后折叠
 *  - 每条 assistant 消息显示输入/输出 token、生成速度等统计
 *  - 可随时停止生成
 *  - 历史会话持久化到本地，支持全文搜索
 *  - Markdown 渲染 + 代码高亮 + 代码块复制
 *  - 预置角色（邮件/翻译/代码/周报/润色/总结/通用）
 *  - 斜杠命令（/今日日志、/今日待办、/本周日志、/错别字、/翻译、/润色、/总结、/解释代码）
 *  - AI 输出反写小牛马（追加到日志 / 拆分为待办）
 *  - 消息悬浮工具栏（复制/重新生成/删除本轮）
 *  - 滚动优化（用户上滚不强制跟随 + 回到底部浮标）
 *  - 会话重命名、导出为 Markdown、拖拽文件、快捷键
 */

import React, { Children, useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { IPC } from '@shared/ipc-channels'
import type {
  AIChatMessage,
  AIChatChunkPayload,
  AIChatDonePayload,
  AIChatErrorPayload,
  AIChatStats,
  AIChatRequest,
  AIChatSession,
  AIChatSessionMeta,
  AIChatSearchHit,
  AIChatAttachment,
  TodoItem,
  DailyLog,
} from '@shared/types'
import { PERSONAS, findPersona } from './ai-chat/personas'
import { SLASH_COMMANDS, type SlashCommand } from './ai-chat/slash-commands'
import './AIChat.css'
// 代码高亮主题（浅色，与米黄色系搭配）
import 'highlight.js/styles/atom-one-light.css'

const api = (window as any).electronAPI

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 文件类型对应图标 */
function attachmentIcon(fileType: string): string {
  switch (fileType) {
    case 'docx':
    case 'doc':
      return '📘'
    case 'md':
      return '📝'
    case 'txt':
      return '📄'
    default:
      return '📎'
  }
}

/** 把附件内容拼接到用户提问前面，形成给 LLM 的完整 prompt */
function buildPromptWithAttachments(text: string, attachments?: AIChatAttachment[]): string {
  if (!attachments || attachments.length === 0) return text
  const blocks = attachments.map((a, i) => {
    const meta = `${a.fileName} · ${formatFileSize(a.sizeBytes)}${a.truncated ? ` · 已截取前 ${a.content.length} 字（原文 ${a.charCount} 字）` : ''}`
    // 用 Markdown 代码块包裹文件内容，最大限度保留原始格式
    return `### 📎 附件 ${i + 1}：${meta}

\`\`\`
${a.content}
\`\`\``
  }).join('\n\n')

  const question = text.trim() || '请基于以上附件内容给出回答。'
  return `我提供了 ${attachments.length} 个附件作为上下文，请阅读后回答我的问题。

${blocks}

---

**我的问题**：${question}`
}

/** 相对时间：今天显示 HH:mm，昨天显示「昨天」，更早显示 M/D */
function relativeTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 把大数字格式化为紧凑形式：12_345 → 12.3k，2_345_678 → 2.3M */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(2) + 'M'
}

/** 把命中关键词高亮（返回 React 节点数组） */
function highlight(text: string, keyword: string): React.ReactNode {
  if (!keyword) return text
  const lower = text.toLowerCase()
  const kw = keyword.toLowerCase()
  const parts: React.ReactNode[] = []
  let i = 0
  let idx = lower.indexOf(kw)
  let k = 0
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={k++}>{text.slice(idx, idx + kw.length)}</mark>)
    i = idx + kw.length
    idx = lower.indexOf(kw, i)
  }
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

// ── Mermaid 按需加载（首次渲染时才拉包，避免冷启动成本） ───
let mermaidInstance: any = null
let mermaidLoading: Promise<any> | null = null
async function loadMermaid(): Promise<any> {
  if (mermaidInstance) return mermaidInstance
  if (mermaidLoading) return mermaidLoading
  mermaidLoading = import('mermaid').then(mod => {
    const m = mod.default
    // Initialize once; keep layout/typography inline-friendly
    m.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
      fontFamily: 'inherit',
      flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false },
      sequence: { useMaxWidth: false },
      gantt: { useMaxWidth: false },
    })
    mermaidInstance = m
    console.log('[AIChat] mermaid loaded')
    return m
  }).catch(err => {
    console.error('[AIChat] mermaid 加载失败:', err)
    mermaidLoading = null
    throw err
  })
  return mermaidLoading
}

/** 递归提取 React children 中的纯文本 */
function extractCodeText(node: React.ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (typeof node === 'object' && 'props' in (node as any)) {
    return extractCodeText((node as any).props?.children)
  }
  return ''
}

// ── Mermaid 图表组件：解析失败时软降级为"查看源码"面板 ─────
function MermaidDiagram({ source }: { source: string }) {
  const [svg, setSvg] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const [showSrc, setShowSrc] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const code = source.trim()
    if (!code) {
      setSvg('')
      setErr(null)
      return
    }
    let cancelled = false
    // Debounce to avoid re-rendering mid-stream on every chunk
    const timer = setTimeout(async () => {
      try {
        const m = await loadMermaid()
        const id = 'mmd-' + Math.random().toString(36).slice(2, 10)
        const result = await m.render(id, code)
        if (!cancelled) {
          setSvg(result.svg || '')
          setErr(null)
        }
      } catch (e: any) {
        if (!cancelled) {
          // Keep previous svg (if any) so stream updates don't flash; only surface error when no svg
          setErr(e?.message ? String(e.message) : String(e))
        }
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source])

  const handleCopySource = useCallback(() => {
    navigator.clipboard.writeText(source).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [source])

  const handleSaveSvg = useCallback(() => {
    if (!svg) return
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mermaid-diagram.svg'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [svg])

  // Error state with no successful svg: degrade to source view
  if (err && !svg) {
    return (
      <div className="mermaid-block mermaid-block-error">
        <div className="mermaid-toolbar">
          <span className="mermaid-badge mermaid-badge-error">⚠ Mermaid 渲染失败</span>
          <div className="mermaid-toolbar-spacer" />
          <button className="mermaid-btn" onClick={handleCopySource} title="复制源码">
            {copied ? '✓' : '📋'}
          </button>
        </div>
        <pre className="mermaid-source">{source}</pre>
        <div className="mermaid-error-msg" title={err}>{err}</div>
      </div>
    )
  }

  return (
    <div className="mermaid-block">
      <div className="mermaid-toolbar">
        <span className={'mermaid-badge' + (err ? ' mermaid-badge-stale' : '')}>
          🧩 Mermaid{err ? ' · 语法待完成' : ''}
        </span>
        <div className="mermaid-toolbar-spacer" />
        <button className="mermaid-btn" onClick={() => setZoom(z => Math.max(0.4, +(z - 0.2).toFixed(1)))} title="缩小">➖</button>
        <button className="mermaid-btn" onClick={() => setZoom(1)} title="还原 100%">{Math.round(zoom * 100)}%</button>
        <button className="mermaid-btn" onClick={() => setZoom(z => Math.min(3, +(z + 0.2).toFixed(1)))} title="放大">➕</button>
        <button className="mermaid-btn" onClick={handleSaveSvg} title="保存为 SVG" disabled={!svg}>💾</button>
        <button className="mermaid-btn" onClick={handleCopySource} title="复制源码">
          {copied ? '✓' : '📋'}
        </button>
        <button className="mermaid-btn" onClick={() => setShowSrc(s => !s)} title="切换源码/图表">
          {showSrc ? '图' : '源码'}
        </button>
      </div>
      {showSrc ? (
        <pre className="mermaid-source">{source}</pre>
      ) : (
        <div className="mermaid-svg-scroll">
          {svg ? (
            <div
              className="mermaid-svg-wrapper"
              style={{ transform: `scale(${zoom})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="mermaid-loading">正在渲染图表…</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── 带复制按钮的代码块（mermaid 走专用渲染） ─────
function CodeBlock({ children }: { children: React.ReactNode }) {
  // Detect language from the inner <code className="language-xxx"> element
  const childArray = Children.toArray(children)
  const firstChild: any = childArray[0]
  const className: string = firstChild?.props?.className || ''
  const isMermaid = /\blanguage-mermaid\b/.test(className)

  const [copied, setCopied] = useState(false)
  const preRef = useRef<HTMLPreElement | null>(null)
  const handleCopy = useCallback(() => {
    const text = preRef.current?.innerText ?? ''
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }, [])

  if (isMermaid) {
    const source = extractCodeText(firstChild?.props?.children)
    return <MermaidDiagram source={source} />
  }

  return (
    <div className="code-block-wrapper">
      <button className="code-copy-btn" onClick={handleCopy} title="复制代码">
        {copied ? '✓ 已复制' : '📋'}
      </button>
      <pre className="md-pre" ref={preRef}>{children}</pre>
    </div>
  )
}

// ── Markdown 渲染（memo 化：同样的文本不重复解析） ──
const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeHighlight, { ignoreMissing: true, detect: true }],
          [rehypeKatex, { strict: false, throwOnError: false, output: 'html' }],
        ]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a href={href} onClick={e => {
              e.preventDefault()
              if (href) window.open(href, '_blank')
            }}>{children}</a>
          ),
        }}
      >{text}</ReactMarkdown>
    </div>
  )
})

// ── 单条消息组件 ────────────────────────────────
interface MessageBubbleProps {
  msg: AIChatMessage
  streaming: boolean
  canRegenerate: boolean   // 仅最后一条 assistant 可重新生成
  onCopy: (msg: AIChatMessage) => void
  onRegenerate: (msg: AIChatMessage) => void
  onDelete: (msg: AIChatMessage) => void
  onAppendToLog: (msg: AIChatMessage) => void
  onExtractTodos: (msg: AIChatMessage) => void
  onExportImage: (msg: AIChatMessage, el: HTMLElement) => void
  onSaveAsDoc: (msg: AIChatMessage) => void
}

function MessageBubble({
  msg, streaming, canRegenerate,
  onCopy, onRegenerate, onDelete, onAppendToLog, onExtractTodos, onExportImage, onSaveAsDoc,
}: MessageBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [reasoningOpen, setReasoningOpen] = useState(streaming)
  const lastStreamingRef = useRef(streaming)
  useEffect(() => {
    if (lastStreamingRef.current !== streaming) {
      setReasoningOpen(streaming)
      lastStreamingRef.current = streaming
    }
  }, [streaming])

  const isUser = msg.role === 'user'
  const hasReasoning = !!msg.reasoning && msg.reasoning.trim().length > 0
  const hasAttachments = isUser && msg.attachments && msg.attachments.length > 0
  // 仅非流式、且有内容或附件时才显示工具栏
  const showToolbar = !streaming && (msg.content || hasAttachments)

  return (
    <div className={`chat-row ${isUser ? 'user' : 'assistant'}`}>
      <div className="chat-avatar">{isUser ? '🧑' : '🐱'}</div>
      <div className="chat-bubble" ref={bubbleRef}>
        {/* 用户消息的附件列表（只读 chip） */}
        {hasAttachments && (
          <div className="message-attachments">
            {msg.attachments!.map(a => (
              <div
                key={a.id}
                className="attachment-chip readonly"
                title={`${a.fileName}\n${formatFileSize(a.sizeBytes)} · ${a.charCount} 字${a.truncated ? `（已截取前 ${a.content.length} 字）` : ''}`}
              >
                <span className="attachment-icon">{attachmentIcon(a.fileType)}</span>
                <span className="attachment-name">{a.fileName}</span>
                <span className="attachment-size">{formatFileSize(a.sizeBytes)}</span>
                {a.truncated && <span className="attachment-badge">截取</span>}
              </div>
            ))}
          </div>
        )}

        {hasReasoning && (
          <div className={`reasoning-block ${reasoningOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="reasoning-toggle"
              onClick={() => setReasoningOpen(v => !v)}
              title="思考过程"
            >
              <span className="reasoning-caret">{reasoningOpen ? '▾' : '▸'}</span>
              <span className="reasoning-label">
                {streaming ? '💭 正在思考…' : '💭 思考过程'}
              </span>
              <span className="reasoning-chars">({msg.reasoning!.length} 字)</span>
            </button>
            {reasoningOpen && (
              <pre className="reasoning-content">{msg.reasoning}</pre>
            )}
          </div>
        )}

        {msg.content && (
          <div className="content-text">
            {isUser
              ? <span className="user-text">{msg.content}</span>
              : <MarkdownContent text={msg.content} />
            }
            {streaming && <span className="caret">▍</span>}
          </div>
        )}

        {!msg.content && streaming && !hasReasoning && (
          <div className="content-text placeholder">正在等待响应…<span className="caret">▍</span></div>
        )}

        {msg.stats && !streaming && (
          <div className="stats-bar" title={msg.stats.fromApiUsage ? '统计来自 API usage' : '本地估算（服务端未返回 usage）'}>
            <span>输入 <b>{msg.stats.promptTokens}</b> tok</span>
            <span>输出 <b>{msg.stats.completionTokens}</b> tok</span>
            <span><b>{msg.stats.tokensPerSecond}</b> tok/s</span>
            <span>首 token {formatMs(msg.stats.firstTokenLatency)}</span>
            <span>总耗时 {formatMs(msg.stats.totalDurationMs)}</span>
            {!msg.stats.fromApiUsage && <span className="est-badge">估算</span>}
          </div>
        )}

        {/* 消息工具栏 */}
        {showToolbar && (
          <div className="msg-toolbar">
            <button className="msg-tool-btn" onClick={() => onCopy(msg)} title="复制">📋</button>
            <button
              className="msg-tool-btn"
              onClick={() => bubbleRef.current && onExportImage(msg, bubbleRef.current)}
              title="导出为图片"
            >📸</button>
            {!isUser && canRegenerate && (
              <button className="msg-tool-btn" onClick={() => onRegenerate(msg)} title="重新生成">🔄</button>
            )}
            {!isUser && (
              <>
                <button className="msg-tool-btn" onClick={() => onAppendToLog(msg)} title="追加到今日日志">📝</button>
                <button className="msg-tool-btn" onClick={() => onExtractTodos(msg)} title="从回复中拆分为今日待办">📋+</button>
                <button className="msg-tool-btn" onClick={() => onSaveAsDoc(msg)} title="保存为本地 Markdown 文档">💾</button>
              </>
            )}
            <button className="msg-tool-btn msg-tool-danger" onClick={() => onDelete(msg)} title="删除本轮">🗑</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 斜杠命令菜单 ─────────────────────────────
interface SlashMenuProps {
  commands: SlashCommand[]
  activeIndex: number
  onPick: (cmd: SlashCommand) => void
  onHover: (index: number) => void
  onDelete?: (cmd: SlashCommand) => void
}
function SlashMenu({ commands, activeIndex, onPick, onHover, onDelete }: SlashMenuProps) {
  if (commands.length === 0) {
    return <div className="slash-menu empty">没有匹配的命令</div>
  }
  const favorite = commands.filter(c => c.group === 'favorite')
  const xiaoniu = commands.filter(c => c.group === 'xiaoniu')
  const prompt = commands.filter(c => c.group === 'prompt')
  let runningIndex = 0
  const renderGroup = (list: SlashCommand[], title: string) => {
    if (list.length === 0) return null
    return (
      <div key={title}>
        <div className="slash-group-title">{title}</div>
        {list.map((c) => {
          const idx = runningIndex++
          return (
            <div
              key={c.id}
              className={`slash-item ${idx === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => onHover(idx)}
              onMouseDown={e => { e.preventDefault(); onPick(c) }}
            >
              <span className="slash-icon">{c.icon}</span>
              <span className="slash-label">{c.label}</span>
              <span className="slash-trigger">{c.trigger}</span>
              <span className="slash-hint">{c.hint}</span>
              {c.deletable && onDelete && (
                <button
                  className="slash-delete"
                  title="删除这条收藏"
                  onMouseDown={e => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDelete(c)
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className="slash-menu">
      {renderGroup(favorite, '⭐ 我的收藏')}
      {renderGroup(xiaoniu, '小牛马联动')}
      {renderGroup(prompt, '通用提示词')}
    </div>
  )
}

// ── 主组件 ─────────────────────────────────────
export default function AIChat() {
  // 当前会话
  const [sessionId, setSessionId] = useState<string>(() => uid())
  const [sessionCreatedAt] = useState<number>(() => Date.now())
  const [personaId, setPersonaId] = useState<string>('general')
  const [messages, setMessages] = useState<AIChatMessage[]>([])
  const [input, setInput] = useState('')
  const [currentReqId, setCurrentReqId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)   // 非错误的临时反馈（如"已追加到日志"）

  // 历史 & 搜索
  const [sessions, setSessions] = useState<AIChatSessionMeta[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<AIChatSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)

  // ── 主题：'light' | 'dark' | 'system'（持久化到 localStorage） ──
  type ThemeMode = 'light' | 'dark' | 'system'
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('aichat:theme') as ThemeMode | null
    return saved ?? 'system'
  })
  // 实际生效的主题（system 时取系统偏好）
  const [effectiveTheme, setEffectiveTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('aichat:theme') as ThemeMode | null
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  // 监听 themeMode 变化，同步 effectiveTheme 和 localStorage
  useEffect(() => {
    localStorage.setItem('aichat:theme', themeMode)
    if (themeMode === 'system') {
      // 跟随系统：订阅 prefers-color-scheme 媒体查询
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const update = () => setEffectiveTheme(mq.matches ? 'dark' : 'light')
      update()
      mq.addEventListener('change', update)
      return () => mq.removeEventListener('change', update)
    }
    setEffectiveTheme(themeMode)
    return
  }, [themeMode])
  // 点一下循环切换：light → dark → system
  const cycleTheme = useCallback(() => {
    setThemeMode(m => (m === 'light' ? 'dark' : m === 'dark' ? 'system' : 'light'))
  }, [])
  const themeIcon = themeMode === 'system' ? '🖥️' : effectiveTheme === 'dark' ? '🌙' : '☀️'
  const themeLabel =
    themeMode === 'system'
      ? `跟随系统 · 当前${effectiveTheme === 'dark' ? '深色' : '浅色'}`
      : themeMode === 'dark'
        ? '深色'
        : '浅色'

  // ── Token/成本单价（每百万 token 的 USD 单价，从 localStorage 读取） ──
  const [pricePromptPerM, setPricePromptPerM] = useState<number>(() =>
    Number(localStorage.getItem('aichat:price:prompt') ?? '0.15'),
  )
  const [priceCompletionPerM, setPriceCompletionPerM] = useState<number>(() =>
    Number(localStorage.getItem('aichat:price:completion') ?? '0.60'),
  )
  useEffect(() => {
    localStorage.setItem('aichat:price:prompt', String(pricePromptPerM))
  }, [pricePromptPerM])
  useEffect(() => {
    localStorage.setItem('aichat:price:completion', String(priceCompletionPerM))
  }, [priceCompletionPerM])
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false)

  // ── 提示词收藏夹（本地持久化） ──
  // 结构：{ id, trigger, label, template }[]，group 固定为 'favorite'
  const [favorites, setFavorites] = useState<SlashCommand[]>(() => {
    try {
      const raw = localStorage.getItem('aichat:favorites')
      if (!raw) return []
      const parsed = JSON.parse(raw) as SlashCommand[]
      // Ensure group / deletable flags regardless of stored shape
      return parsed.map(f => ({ ...f, group: 'favorite' as const, deletable: true }))
    } catch {
      return []
    }
  })
  useEffect(() => {
    localStorage.setItem('aichat:favorites', JSON.stringify(favorites))
  }, [favorites])
  /** 把当前输入框内容保存为收藏 */
  const saveFavorite = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const firstLine = trimmed.split('\n')[0].slice(0, 30)
    const label = (firstLine || '未命名收藏').replace(/\s+/g, ' ')
    const fav: SlashCommand = {
      id: 'fav-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      trigger: '/收藏-' + label.slice(0, 10),
      label,
      icon: '⭐',
      hint: trimmed.slice(0, 60) + (trimmed.length > 60 ? '…' : ''),
      group: 'favorite',
      template: trimmed,
      deletable: true,
    }
    setFavorites(prev => [fav, ...prev])
    setStatusMsg(`⭐ 已保存为收藏：${label}`)
    setTimeout(() => setStatusMsg(null), 2000)
  }, [])
  const removeFavorite = useCallback((cmd: SlashCommand) => {
    setFavorites(prev => prev.filter(f => f.id !== cmd.id))
  }, [])

  // 重命名状态
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  // 滚动状态
  const [atBottom, setAtBottom] = useState(true)
  const [newMsgCount, setNewMsgCount] = useState(0)

  // 斜杠命令弹层
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashActiveIdx, setSlashActiveIdx] = useState(0)

  // 拖拽高亮
  const [dragOver, setDragOver] = useState(false)

  // 当前正在撰写消息的附件列表（发送后清空）
  const [attachments, setAttachments] = useState<AIChatAttachment[]>([])

  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // 保存当前最新消息数组，供 done/error 回调使用（避免闭包陈旧）
  const messagesRef = useRef<AIChatMessage[]>([])
  const sessionIdRef = useRef<string>(sessionId)
  const sessionCreatedAtRef = useRef<number>(sessionCreatedAt)
  const personaIdRef = useRef<string>(personaId)
  const atBottomRef = useRef<boolean>(true)
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { personaIdRef.current = personaId }, [personaId])
  useEffect(() => { atBottomRef.current = atBottom }, [atBottom])

  // 覆盖 App.css 对 body 的 overflow:hidden
  useLayoutEffect(() => {
    document.body.style.overflow = 'auto'
    document.body.style.background = '#f7f5ef'
    return () => { document.body.style.overflow = '' }
  }, [])

  // ── 会话列表加载 ──────────────────────────────
  const refreshSessions = useCallback(async () => {
    const list = await api.invoke(IPC.AI_CHAT_LIST_SESSIONS) as AIChatSessionMeta[]
    setSessions(list)
  }, [])

  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // 初始聚焦 & 监听主进程唤起事件
  useEffect(() => {
    inputRef.current?.focus()
    const off = api.on(IPC.AI_CHAT_FOCUS_INPUT, () => inputRef.current?.focus())
    return off
  }, [])

  // ── 滚动管理 ──────────────────────────────────
  const scrollToBottom = useCallback((smooth = true) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setNewMsgCount(0)
  }, [])

  // 监听用户手动滚动：距离底部 < 40px 视为 atBottom
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const handle = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      setAtBottom(near)
      if (near) setNewMsgCount(0)
    }
    el.addEventListener('scroll', handle, { passive: true })
    return () => el.removeEventListener('scroll', handle)
  }, [])

  // 消息更新时的自动跟随逻辑：仅在用户位于底部时自动跟随
  useEffect(() => {
    if (atBottomRef.current) {
      const el = listRef.current
      if (el) el.scrollTop = el.scrollHeight
    } else if (currentReqId) {
      // 用户在查看历史时，累加新消息数
      setNewMsgCount(n => n + 1)
    }
  }, [messages.length, currentReqId])

  // 流式 chunk 时也要跟随（仅当 atBottom）
  useEffect(() => {
    if (!atBottomRef.current) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // ── 持久化当前会话 ────────────────────────────
  const persistSession = useCallback(async (msgs: AIChatMessage[]) => {
    if (msgs.length === 0) return
    const session: AIChatSession = {
      id: sessionIdRef.current,
      title: '',
      preview: '',
      messageCount: msgs.length,
      createdAt: sessionCreatedAtRef.current,
      updatedAt: Date.now(),
      messages: msgs,
      personaId: personaIdRef.current,
    }
    try {
      await api.invoke(IPC.AI_CHAT_SAVE_SESSION, session)
      refreshSessions()
    } catch (e) {
      console.error('[AIChat] 保存会话失败:', e)
    }
  }, [refreshSessions])

  // ── 订阅流式事件 ──────────────────────────────
  useEffect(() => {
    const offChunk = api.on(IPC.AI_CHAT_CHUNK, (payload: unknown) => {
      const p = payload as AIChatChunkPayload
      setMessages(prev => prev.map(m =>
        m.id === p.requestId ? { ...m, content: p.content, reasoning: p.reasoning } : m
      ))
    })
    const offDone = api.on(IPC.AI_CHAT_DONE, (payload: unknown) => {
      const p = payload as AIChatDonePayload
      setMessages(prev => {
        const next = prev.map(m =>
          m.id === p.requestId
            ? { ...m, content: p.content, reasoning: p.reasoning, stats: p.stats }
            : m
        )
        setTimeout(() => persistSession(next), 0)
        return next
      })
      setCurrentReqId(cur => (cur === p.requestId ? null : cur))
    })
    const offErr = api.on(IPC.AI_CHAT_ERROR, (payload: unknown) => {
      const p = payload as AIChatErrorPayload
      setError(p.error)
      setMessages(prev => {
        const next = prev.map(m =>
          m.id === p.requestId
            ? {
                ...m,
                content: m.content || `⚠️ 出错：${p.error}`,
                stats: m.stats ?? ({
                  promptTokens: 0, completionTokens: 0, tokensPerSecond: 0,
                  firstTokenLatency: 0, totalDurationMs: 0, fromApiUsage: false,
                } as AIChatStats),
              }
            : m
        )
        setTimeout(() => persistSession(next), 0)
        return next
      })
      setCurrentReqId(cur => (cur === p.requestId ? null : cur))
    })
    return () => { offChunk(); offDone(); offErr() }
  }, [persistSession])

  // ── 构造请求（带 persona 系统提示词 + 附件拼接） ──
  const buildRequest = useCallback((
    history: AIChatMessage[],
    nextUserText: string,
    nextAttachments: AIChatAttachment[] | undefined,
    reqId: string,
  ): AIChatRequest => {
    const persona = findPersona(personaIdRef.current)
    const systemMsgs: Array<Pick<AIChatMessage, 'role' | 'content'>> = persona.systemPrompt
      ? [{ role: 'system' as const, content: persona.systemPrompt }]
      : []
    // 历史消息里如果是 user 且有 attachments，需要把附件内容拼接进 content 发给 LLM
    const historyForApi = history
      .filter(m => m.role !== 'assistant' || m.content)
      .map(m => ({
        role: m.role,
        content: m.role === 'user' && m.attachments && m.attachments.length > 0
          ? buildPromptWithAttachments(m.content, m.attachments)
          : m.content,
      }))
    // 当前这一轮的 user 消息也要拼接附件内容
    const finalUserContent = buildPromptWithAttachments(nextUserText, nextAttachments)
    return {
      requestId: reqId,
      messages: [...systemMsgs, ...historyForApi, { role: 'user', content: finalUserContent }],
    }
  }, [])

  // ── 发送消息 ──────────────────────────────────
  const handleSend = useCallback(() => {
    const text = input.trim()
    // 允许「只发送附件不打字」的场景
    if ((!text && attachments.length === 0) || currentReqId) return

    setError(null)
    setStatusMsg(null)
    const userMsg: AIChatMessage = {
      id: uid(),
      role: 'user',
      content: text,              // 存用户原始输入（不含附件原文），附件单独存 attachments
      attachments: attachments.length > 0 ? [...attachments] : undefined,
      createdAt: Date.now(),
    }
    const reqId = uid()
    const assistantMsg: AIChatMessage = {
      id: reqId, role: 'assistant', content: '', reasoning: '', createdAt: Date.now(),
    }

    const req = buildRequest(messages, text, attachments, reqId)

    setMessages(prev => [...prev, userMsg, assistantMsg])
    setInput('')
    setAttachments([])                       // 发送后清空附件，下一轮独立
    setCurrentReqId(reqId)
    setAtBottom(true)                        // 发送消息时视为回到底部
    setTimeout(() => scrollToBottom(false), 0)

    api.invoke(IPC.AI_CHAT_START, req).catch((e: unknown) => {
      console.error('[AIChat] invoke start failed', e)
      setError(e instanceof Error ? e.message : String(e))
      setCurrentReqId(null)
    })
  }, [input, attachments, currentReqId, messages, buildRequest, scrollToBottom])

  // ── 停止生成 ──────────────────────────────────
  const handleStop = useCallback(() => {
    if (!currentReqId) return
    api.send(IPC.AI_CHAT_STOP, currentReqId)
  }, [currentReqId])

  // ── 新建对话 ─────────────────────────────────
  const handleNewChat = useCallback(async () => {
    if (currentReqId) {
      api.send(IPC.AI_CHAT_STOP, currentReqId)
    }
    const nid = uid()
    sessionIdRef.current = nid
    sessionCreatedAtRef.current = Date.now()
    setSessionId(nid)
    setMessages([])
    setAttachments([])                // 切会话时清空附件
    setInput('')
    setError(null)
    setStatusMsg(null)
    setCurrentReqId(null)
    setAtBottom(true)
    setNewMsgCount(0)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [currentReqId])

  // ── 选择历史会话 ─────────────────────────────
  const handleSelectSession = useCallback(async (id: string) => {
    if (id === sessionIdRef.current) return
    if (currentReqId) {
      api.send(IPC.AI_CHAT_STOP, currentReqId)
      setCurrentReqId(null)
    }
    const s = await api.invoke(IPC.AI_CHAT_GET_SESSION, id) as AIChatSession | null
    if (!s) return
    sessionIdRef.current = s.id
    sessionCreatedAtRef.current = s.createdAt
    setSessionId(s.id)
    setMessages(s.messages || [])
    setPersonaId(s.personaId || 'general')
    setAttachments([])                // 切会话时清空附件
    setInput('')
    setError(null)
    setStatusMsg(null)
    setAtBottom(true)
    setNewMsgCount(0)
    setTimeout(() => scrollToBottom(false), 50)
  }, [currentReqId, scrollToBottom])

  // ── 删除会话 ─────────────────────────────────
  const handleDeleteSession = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('确定删除这段对话？不可恢复。')) return
    await api.invoke(IPC.AI_CHAT_DELETE_SESSION, id)
    if (id === sessionIdRef.current) {
      handleNewChat()
    }
    refreshSessions()
    if (searchQuery.trim()) {
      const hits = await api.invoke(IPC.AI_CHAT_SEARCH, searchQuery) as AIChatSearchHit[]
      setSearchHits(hits)
    }
  }, [handleNewChat, refreshSessions, searchQuery])

  // ── 重命名会话 ───────────────────────────────
  const startRename = useCallback((id: string, currentTitle: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setRenamingId(id)
    setRenameValue(currentTitle)
  }, [])

  const commitRename = useCallback(async () => {
    if (!renamingId) return
    const title = renameValue.trim()
    if (title) {
      await api.invoke(IPC.AI_CHAT_RENAME_SESSION, { id: renamingId, title })
      refreshSessions()
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, refreshSessions])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  // ── 搜索 debounce ────────────────────────────
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const hits = await api.invoke(IPC.AI_CHAT_SEARCH, q) as AIChatSearchHit[]
        setSearchHits(hits)
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => clearTimeout(t)
  }, [searchQuery])

  // ── 斜杠命令筛选 ─────────────────────────────
  const filteredSlash = useMemo(() => {
    if (!slashOpen) return []
    // Merge user favorites on top so they appear first
    const merged: SlashCommand[] = [...favorites, ...SLASH_COMMANDS]
    const q = slashFilter.trim().toLowerCase()
    if (!q) return merged
    return merged.filter(c =>
      c.trigger.toLowerCase().includes(q) ||
      c.label.toLowerCase().includes(q) ||
      c.hint.toLowerCase().includes(q)
    )
  }, [slashFilter, slashOpen, favorites])

  useEffect(() => {
    // 切换筛选时重置 active 索引
    setSlashActiveIdx(0)
  }, [slashFilter, slashOpen])

  const pickSlashCommand = useCallback(async (cmd: SlashCommand) => {
    setSlashOpen(false)
    setSlashFilter('')
    try {
      const text = cmd.template ?? (cmd.resolve ? await cmd.resolve() : '')
      if (text == null) return
      setInput(text)
      setTimeout(() => {
        const el = inputRef.current
        if (el) {
          el.focus()
          // 选中占位符（若有），方便用户替换
          const placeholderMatch = text.match(/\uff08[^）]*\uff09/)
          if (placeholderMatch) {
            const idx = text.indexOf(placeholderMatch[0])
            el.setSelectionRange(idx, idx + placeholderMatch[0].length)
          } else {
            el.setSelectionRange(text.length, text.length)
          }
        }
      }, 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // ── 输入框 onChange：检测开头 / 触发菜单 ────
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setInput(v)
    // 整个输入框以 / 开头且没有换行，视为命令模式
    if (v.startsWith('/') && !v.includes('\n')) {
      setSlashOpen(true)
      setSlashFilter(v.slice(1))
    } else {
      setSlashOpen(false)
      setSlashFilter('')
    }
  }, [])

  // ── 键盘处理 ─────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 斜杠菜单开启时：方向键导航 + Enter 确认 + Esc 关闭
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActiveIdx(i => Math.min(i + 1, Math.max(0, filteredSlash.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActiveIdx(i => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        if (filteredSlash[slashActiveIdx]) {
          e.preventDefault()
          pickSlashCommand(filteredSlash[slashActiveIdx])
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }, [slashOpen, filteredSlash, slashActiveIdx, pickSlashCommand, handleSend])

  // ── 全局快捷键 ──────────────────────────────
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'n') { e.preventDefault(); handleNewChat(); return }
      if (meta && e.key === 'f') { e.preventDefault(); searchInputRef.current?.focus(); searchInputRef.current?.select(); return }
      if (meta && e.key === 'b') { e.preventDefault(); setSidebarVisible(v => !v); return }
      if (e.key === 'Escape') {
        if (currentReqId) { api.send(IPC.AI_CHAT_STOP, currentReqId); return }
        if (searchQuery) { setSearchQuery(''); return }
      }
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [handleNewChat, currentReqId, searchQuery])

  // ── 消息工具栏动作 ───────────────────────────
  /** 把消息卡片 DOM 渲染成 PNG 图片并下载（使用 html2canvas） */
  const handleExportImage = useCallback(async (msg: AIChatMessage, el: HTMLElement) => {
    try {
      setStatusMsg('📸 正在生成图片…')
      // Dynamic import: only load html2canvas when user triggers this action
      const html2canvas = (await import('html2canvas')).default
      // Background color must be resolved explicitly to avoid transparent PNG
      const isDark = document.querySelector('.aichat-container')?.getAttribute('data-theme') === 'dark'
      const canvas = await html2canvas(el, {
        backgroundColor: isDark ? '#2a2824' : '#fffef7',
        scale: window.devicePixelRatio >= 2 ? 2 : 1.5,
        logging: false,
        useCORS: true,
      })
      const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
      if (!blob) throw new Error('canvas.toBlob 返回 null')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const ts = new Date()
      const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}`
      a.href = url
      a.download = `${msg.role === 'user' ? '问' : '答'}-${stamp}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatusMsg('✓ 图片已保存')
      setTimeout(() => setStatusMsg(null), 2000)
    } catch (err: any) {
      console.error('[AIChat] 导出图片失败:', err)
      setError(`导出图片失败：${err?.message ?? String(err)}`)
    }
  }, [])

  const handleCopyMsg = useCallback((msg: AIChatMessage) => {
    navigator.clipboard.writeText(msg.content).then(() => {
      setStatusMsg('已复制到剪贴板')
      setTimeout(() => setStatusMsg(null), 1500)
    }).catch(() => {})
  }, [])

  /** 把 AI 答复保存为本地 markdown 文档（默认 userData/reports/） */
  const handleSaveAsDoc = useCallback(async (msg: AIChatMessage) => {
    // 从内容第一行或前 20 字生成默认文件名
    const firstLine = msg.content.split('\n').find(l => l.trim()) ?? ''
    const stripped = firstLine.replace(/^#+\s*/, '').trim().slice(0, 30)
    const suggestedName = `${stripped || '小牛马对话'}-${localDateStr()}`
    const r = await api.invoke(IPC.REPORT_SAVE, {
      content: msg.content,
      suggestedName,
    }) as { ok: boolean; filePath?: string; reason?: string }
    if (r.ok) {
      setStatusMsg(`✓ 已保存：${r.filePath}`)
      setTimeout(() => setStatusMsg(null), 3000)
    } else if (r.reason !== 'cancelled') {
      setError(`保存失败：${r.reason}`)
    }
  }, [])

  const handleDeleteMsg = useCallback((msg: AIChatMessage) => {
    // 删除本轮：若是 assistant，连同其上一条 user 一起删；若是 user，连同其下一条 assistant 一起删
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === msg.id)
      if (idx === -1) return prev
      const next = [...prev]
      if (msg.role === 'assistant') {
        // 同时删掉上一条 user
        if (idx > 0 && next[idx - 1].role === 'user') next.splice(idx - 1, 2)
        else next.splice(idx, 1)
      } else {
        // user：删掉它 + 紧随其后的 assistant（若有）
        if (idx + 1 < next.length && next[idx + 1].role === 'assistant') next.splice(idx, 2)
        else next.splice(idx, 1)
      }
      setTimeout(() => persistSession(next), 0)
      return next
    })
  }, [persistSession])

  const handleRegenerate = useCallback((msg: AIChatMessage) => {
    if (msg.role !== 'assistant' || currentReqId) return
    // 找到对应的 user 消息（紧邻前一条）
    const idx = messages.findIndex(m => m.id === msg.id)
    if (idx === -1 || idx === 0) return
    const prevUser = messages[idx - 1]
    if (prevUser.role !== 'user') return

    // 新建 reqId 替换原 assistant 消息（附件沿用 prevUser 上的 attachments）
    const reqId = uid()
    const historyBefore = messages.slice(0, idx - 1)
    const req = buildRequest(historyBefore, prevUser.content, prevUser.attachments, reqId)
    const newAssistant: AIChatMessage = {
      id: reqId, role: 'assistant', content: '', reasoning: '', createdAt: Date.now(),
    }
    setMessages([...historyBefore, prevUser, newAssistant])
    setCurrentReqId(reqId)
    setError(null)
    setAtBottom(true)
    api.invoke(IPC.AI_CHAT_START, req).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setCurrentReqId(null)
    })
  }, [messages, currentReqId, buildRequest])

  const handleAppendToLog = useCallback(async (msg: AIChatMessage) => {
    try {
      const today = localDateStr()
      const existing = await api.invoke(IPC.LOG_GET, today) as DailyLog | null
      const prefix = existing?.eod_log ? existing.eod_log + '\n\n' : ''
      const now = new Date()
      const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const updated = `${prefix}[AI 输出 ${stamp}]\n${msg.content}`
      await api.invoke(IPC.LOG_SAVE, { date: today, eod_log: updated })
      setStatusMsg('✅ 已追加到今日日志')
      setTimeout(() => setStatusMsg(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleExtractTodos = useCallback(async (msg: AIChatMessage) => {
    try {
      setStatusMsg('🔄 正在从回复中提取待办…')
      const result = await api.invoke(IPC.LLM_PARSE_PLAN, msg.content) as { todos: TodoItem[]; error?: string }
      const todos = result.todos || []
      if (todos.length === 0) {
        setStatusMsg(result.error ? `⚠️ 未提取到待办：${result.error}` : '⚠️ 未从回复中识别到待办')
        setTimeout(() => setStatusMsg(null), 2500)
        return
      }
      const today = localDateStr()
      const existing = await api.invoke(IPC.TODOS_GET, today) as TodoItem[]
      // 合并：去重（按 title）
      const existingTitles = new Set(existing.map(t => t.title))
      const added = todos.filter(t => !existingTitles.has(t.title))
      const merged = [...existing, ...added.map((t, i) => ({
        ...t,
        id: String(existing.length + i + 1),
      }))]
      await api.invoke(IPC.TODOS_SAVE, { date: today, todos: merged })
      setStatusMsg(`✅ 已添加 ${added.length} 条到今日待办（跳过重复 ${todos.length - added.length} 条）`)
      setTimeout(() => setStatusMsg(null), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // ── 导出对话为 Markdown ──────────────────────
  const handleExport = useCallback(() => {
    if (messages.length === 0) {
      setStatusMsg('当前对话为空，没有可导出的内容')
      setTimeout(() => setStatusMsg(null), 2000)
      return
    }
    const persona = findPersona(personaId)
    const lines: string[] = []
    lines.push(`# AI 对话导出`)
    lines.push('')
    lines.push(`- 时间：${new Date().toLocaleString()}`)
    lines.push(`- 角色：${persona.icon} ${persona.name}`)
    lines.push(`- 消息数：${messages.length}`)
    lines.push('')
    lines.push('---')
    lines.push('')
    for (const m of messages) {
      const role = m.role === 'user' ? '🧑 用户' : '🐱 助手'
      lines.push(`## ${role}`)
      lines.push('')
      if (m.reasoning) {
        lines.push('<details><summary>💭 思考过程</summary>')
        lines.push('')
        lines.push('```')
        lines.push(m.reasoning)
        lines.push('```')
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }
      lines.push(m.content || '_（无内容）_')
      lines.push('')
      if (m.stats) {
        lines.push(`> 📊 输入 ${m.stats.promptTokens} tok · 输出 ${m.stats.completionTokens} tok · ${m.stats.tokensPerSecond} tok/s`)
        lines.push('')
      }
    }
    const md = lines.join('\n')
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `AI-对话-${localDateStr()}-${Date.now()}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setStatusMsg('✅ 已导出 Markdown 文件')
    setTimeout(() => setStatusMsg(null), 2000)
  }, [messages, personaId])

  // ── 附件：把新读到的附件合并到当前列表（去重 + 提示） ─
  const mergeNewAttachments = useCallback((
    incoming: AIChatAttachment[],
    readErrors: Array<{ fileName: string; error: string }>,
    unsupportedNames: string[],
  ) => {
    if (readErrors.length > 0) {
      setError(`${readErrors.length} 个文件读取失败：` + readErrors.map(e => `${e.fileName}（${e.error}）`).join('；'))
    }
    if (incoming.length === 0) {
      if (unsupportedNames.length > 0) {
        setStatusMsg(`⚠️ 忽略 ${unsupportedNames.length} 个不支持的格式：${unsupportedNames.join('、')}`)
        setTimeout(() => setStatusMsg(null), 2500)
      }
      return
    }
    setAttachments(prev => {
      const existingNames = new Set(prev.map(a => a.fileName))
      const added = incoming.filter(a => !existingNames.has(a.fileName))
      const skipped = incoming.length - added.length
      const bits: string[] = []
      if (added.length > 0) bits.push(`已添加 ${added.length} 个附件`)
      if (skipped > 0) bits.push(`跳过 ${skipped} 个重名`)
      if (unsupportedNames.length > 0) bits.push(`忽略 ${unsupportedNames.length} 个不支持格式`)
      setStatusMsg(bits.join('，'))
      setTimeout(() => setStatusMsg(null), 2500)
      return [...prev, ...added]
    })
  }, [])

  // ── 附件：点击 📎 打开文件选择器 ───────────
  const handlePickAttachments = useCallback(async () => {
    try {
      const result = await api.invoke(IPC.AI_CHAT_PICK_ATTACHMENTS) as {
        ok: boolean
        canceled?: boolean
        attachments?: AIChatAttachment[]
        errors?: Array<{ fileName: string; error: string }>
      }
      if (!result.ok || result.canceled) return
      mergeNewAttachments(result.attachments || [], result.errors || [], [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [mergeNewAttachments])

  // ── 附件：移除/清空 ──────────────────────
  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // ── 拖拽文件：走附件流程（不再塞到输入框） ───
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    const paths: string[] = []
    const unsupported: string[] = []
    for (const f of files) {
      const fpath = (f as unknown as { path?: string }).path
      if (!fpath) {
        unsupported.push(f.name)
        continue
      }
      const ext = fpath.toLowerCase().split('.').pop() || ''
      if (['txt', 'md', 'docx', 'doc'].includes(ext)) {
        paths.push(fpath)
      } else {
        unsupported.push(f.name)
      }
    }
    if (paths.length === 0) {
      mergeNewAttachments([], [], unsupported)
      return
    }
    try {
      const result = await api.invoke(IPC.AI_CHAT_READ_ATTACHMENTS, paths) as {
        ok: boolean
        attachments: AIChatAttachment[]
        errors: Array<{ fileName: string; error: string }>
      }
      mergeNewAttachments(result.attachments || [], result.errors || [], unsupported)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [mergeNewAttachments])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }, [dragOver])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // 只在离开容器本身时关闭（避免子元素触发）
    if (e.target === e.currentTarget) setDragOver(false)
  }, [])

  // 侧栏展示模式
  const isSearchMode = searchQuery.trim().length > 0
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) return messages[i].id
    }
    return null
  }, [messages])

  // ── 本会话累计 tokens + 成本估算 ──
  // 只统计 assistant 消息里的 stats（用户消息不占 prompt token 统计口径）
  const sessionTokenStats = useMemo(() => {
    let promptTokens = 0
    let completionTokens = 0
    let turns = 0
    for (const m of messages) {
      if (m.role === 'assistant' && m.stats) {
        promptTokens += m.stats.promptTokens || 0
        completionTokens += m.stats.completionTokens || 0
        turns += 1
      }
    }
    // 成本按单价 / 1_000_000 tokens 换算（USD）
    const cost = (promptTokens * pricePromptPerM + completionTokens * priceCompletionPerM) / 1_000_000
    return { promptTokens, completionTokens, turns, cost }
  }, [messages, pricePromptPerM, priceCompletionPerM])

  const currentPersona = findPersona(personaId)

  return (
    <div
      className={`aichat-container ${sidebarVisible ? '' : 'no-sidebar'} ${dragOver ? 'drag-over' : ''}`}
      data-theme={effectiveTheme}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="aichat-header">
        <div className="aichat-left">
          <button
            className="btn-ghost btn-icon"
            onClick={() => setSidebarVisible(v => !v)}
            title={sidebarVisible ? '隐藏历史 (⌘B)' : '显示历史 (⌘B)'}
          >
            {sidebarVisible ? '◀' : '▶'}
          </button>
          <div className="aichat-title">💬 AI 对话</div>

          {/* 角色选择 */}
          <div className="persona-picker">
            <select
              className="persona-select"
              value={personaId}
              onChange={e => setPersonaId(e.target.value)}
              title={currentPersona.systemPrompt ? '当前角色：' + currentPersona.name : '当前角色：通用（使用设置中的全局系统提示词）'}
            >
              {PERSONAS.map(p => (
                <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="aichat-actions">
          {/* Token 累计徽章：本会话累计 in/out tokens + 估算 USD 成本 */}
          <div className="token-badge-wrapper">
            <button
              className="btn-ghost btn-icon token-badge"
              onClick={() => setTokenPanelOpen(v => !v)}
              title="本会话 token 与成本（点击查看详情）"
            >
              🎟 {formatTokenCount(sessionTokenStats.promptTokens + sessionTokenStats.completionTokens)} · $
              {sessionTokenStats.cost < 0.01 && sessionTokenStats.cost > 0
                ? '<0.01'
                : sessionTokenStats.cost.toFixed(sessionTokenStats.cost < 1 ? 4 : 2)}
            </button>
            {tokenPanelOpen && (
              <div className="token-panel" onClick={e => e.stopPropagation()}>
                <div className="token-panel-header">
                  <span>🎟 本会话 Token 与成本</span>
                  <button className="token-panel-close" onClick={() => setTokenPanelOpen(false)}>✕</button>
                </div>
                <div className="token-panel-body">
                  <div className="token-row">
                    <span className="token-label">对话轮数</span>
                    <span className="token-value">{sessionTokenStats.turns}</span>
                  </div>
                  <div className="token-row">
                    <span className="token-label">输入 tokens</span>
                    <span className="token-value">{sessionTokenStats.promptTokens.toLocaleString()}</span>
                  </div>
                  <div className="token-row">
                    <span className="token-label">输出 tokens</span>
                    <span className="token-value">{sessionTokenStats.completionTokens.toLocaleString()}</span>
                  </div>
                  <div className="token-row token-row-total">
                    <span className="token-label">估算成本</span>
                    <span className="token-value">${sessionTokenStats.cost.toFixed(4)}</span>
                  </div>
                  <div className="token-panel-divider" />
                  <div className="token-price-row">
                    <label className="token-price-label">单价（USD / 1M tokens）</label>
                  </div>
                  <div className="token-row">
                    <span className="token-label">Input</span>
                    <input
                      type="number"
                      className="token-price-input"
                      step="0.01"
                      min="0"
                      value={pricePromptPerM}
                      onChange={e => setPricePromptPerM(Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="token-row">
                    <span className="token-label">Output</span>
                    <input
                      type="number"
                      className="token-price-input"
                      step="0.01"
                      min="0"
                      value={priceCompletionPerM}
                      onChange={e => setPriceCompletionPerM(Number(e.target.value) || 0)}
                    />
                  </div>
                  <div className="token-panel-hint">
                    参考价格（USD/1M）：gpt-4o-mini 0.15/0.60，gpt-4o 2.5/10，DeepSeek-V3 0.27/1.1
                  </div>
                </div>
              </div>
            )}
          </div>
          <button className="btn-ghost btn-icon" onClick={cycleTheme} title={`主题：${themeLabel}（点击切换）`}>
            {themeIcon}
          </button>
          <button className="btn-ghost" onClick={handleExport} title="导出为 Markdown 文件">
            ⬇ 导出
          </button>
          <button className="btn-ghost" onClick={handleNewChat} title="新对话 (⌘N)">
            ＋ 新对话
          </button>
        </div>
      </header>

      <div className="aichat-body">
        {sidebarVisible && (
          <aside className="aichat-sidebar">
            <div className="sidebar-search">
              <input
                ref={searchInputRef}
                type="text"
                className="search-input"
                placeholder="🔍 搜索历史 (⌘F)"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button className="search-clear" onClick={() => setSearchQuery('')} title="清空 (Esc)">✕</button>
              )}
            </div>

            <div className="sidebar-list">
              {isSearchMode ? (
                <>
                  <div className="sidebar-hint">
                    {searching ? '搜索中…' :
                      searchHits.length === 0 ? '无匹配结果' :
                      `找到 ${searchHits.length} 个结果`}
                  </div>
                  {searchHits.map(hit => (
                    <div
                      key={hit.sessionId}
                      className={`session-item ${hit.sessionId === sessionId ? 'active' : ''}`}
                      onClick={() => handleSelectSession(hit.sessionId)}
                    >
                      <div className="session-title">{highlight(hit.title, searchQuery)}</div>
                      <div className="session-snippet">{highlight(hit.snippet, searchQuery)}</div>
                      <div className="session-footer">
                        <span className="session-time">{relativeTime(hit.updatedAt)}</span>
                        <span className="session-matches">{hit.matchCount} 处匹配</span>
                        <button className="session-del" onClick={e => handleDeleteSession(hit.sessionId, e)} title="删除">🗑</button>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {sessions.length === 0 && (
                    <div className="sidebar-empty">暂无历史对话</div>
                  )}
                  {sessions.map(s => (
                    <div
                      key={s.id}
                      className={`session-item ${s.id === sessionId ? 'active' : ''}`}
                      onClick={() => handleSelectSession(s.id)}
                      onDoubleClick={e => startRename(s.id, s.title, e)}
                      title="双击重命名"
                    >
                      {renamingId === s.id ? (
                        <input
                          autoFocus
                          className="session-rename-input"
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        <div className="session-title">{s.title}</div>
                      )}
                      <div className="session-snippet">{s.preview || '（空对话）'}</div>
                      <div className="session-footer">
                        <span className="session-time">{relativeTime(s.updatedAt)}</span>
                        <span className="session-count">{s.messageCount} 条</span>
                        <button
                          className="session-del"
                          onClick={e => { e.stopPropagation(); startRename(s.id, s.title) }}
                          title="重命名"
                        >✎</button>
                        <button className="session-del" onClick={e => handleDeleteSession(s.id, e)} title="删除">🗑</button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </aside>
        )}

        <main className="aichat-main">
          <div className="aichat-list" ref={listRef}>
            {messages.length === 0 && (
              <div className="aichat-empty">
                <div className="empty-icon">{currentPersona.icon}</div>
                <div className="empty-text">
                  <b>{currentPersona.name}</b> 准备就绪<br />
                  <small>Enter 发送 · Shift+Enter 换行 · 输入 / 唤出命令 · 📎 添加附件 · 支持 txt / md / docx / doc</small>
                </div>
              </div>
            )}
            {messages.map(m => (
              <MessageBubble
                key={m.id}
                msg={m}
                streaming={m.role === 'assistant' && m.id === currentReqId}
                canRegenerate={m.id === lastAssistantId && !currentReqId}
                onCopy={handleCopyMsg}
                onRegenerate={handleRegenerate}
                onDelete={handleDeleteMsg}
                onAppendToLog={handleAppendToLog}
                onExportImage={handleExportImage}
                onExtractTodos={handleExtractTodos}
                onSaveAsDoc={handleSaveAsDoc}
              />
            ))}

            {/* 回到底部浮标 */}
            {!atBottom && messages.length > 0 && (
              <button
                className="scroll-to-bottom-btn"
                onClick={() => scrollToBottom(true)}
                title="回到底部"
              >
                ⬇ {newMsgCount > 0 ? `${newMsgCount} 条新内容` : '回到底部'}
              </button>
            )}
          </div>

          {error && <div className="aichat-error">⚠️ {error}</div>}
          {statusMsg && <div className="aichat-status">{statusMsg}</div>}

          <div className="aichat-composer">
            {/* 斜杠命令菜单 */}
            {slashOpen && (
              <SlashMenu
                commands={filteredSlash}
                activeIndex={slashActiveIdx}
                onPick={pickSlashCommand}
                onHover={setSlashActiveIdx}
                onDelete={removeFavorite}
              />
            )}

            {/* 待发送附件 chip 列表（可删除） */}
            {attachments.length > 0 && (
              <div className="composer-attachments">
                {attachments.map(a => (
                  <div
                    key={a.id}
                    className="attachment-chip removable"
                    title={`${a.fileName}\n${formatFileSize(a.sizeBytes)} · ${a.charCount} 字${a.truncated ? `（已截取前 ${a.content.length} 字）` : ''}`}
                  >
                    <span className="attachment-icon">{attachmentIcon(a.fileType)}</span>
                    <span className="attachment-name">{a.fileName}</span>
                    <span className="attachment-size">{formatFileSize(a.sizeBytes)}</span>
                    {a.truncated && <span className="attachment-badge">截取</span>}
                    <button
                      className="attachment-remove"
                      onClick={() => handleRemoveAttachment(a.id)}
                      title="移除附件"
                    >×</button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={inputRef}
              className="composer-input"
              placeholder={`输入消息…（Enter 发送，Shift+Enter 换行，/ 唤出命令，📎 添加附件）`}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              rows={3}
            />
            <div className="composer-buttons">
              <span className="composer-hint">
                {currentPersona.icon} {currentPersona.name}
                {messages.length > 0 && <> · {messages.length} 条消息</>}
                {attachments.length > 0 && <> · 📎 {attachments.length} 个附件</>}
              </span>
              <div className="composer-actions-right">
                <button
                  className="btn-ghost"
                  onClick={() => saveFavorite(input)}
                  title="把当前输入保存为收藏（斜杠菜单 → ⭐ 我的收藏）"
                  disabled={!input.trim()}
                >⭐ 收藏</button>
                <button
                  className="btn-ghost"
                  onClick={handlePickAttachments}
                  title="添加附件（支持 txt / md / docx / doc，也可直接拖入窗口）"
                  disabled={!!currentReqId}
                >📎 附件</button>
                {currentReqId ? (
                  <button className="btn-stop" onClick={handleStop}>■ 停止 (Esc)</button>
                ) : (
                  <button
                    className="btn-send"
                    onClick={handleSend}
                    disabled={!input.trim() && attachments.length === 0}
                  >
                    发送 ↵
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* 拖拽蒙层 */}
      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-hint">
            📎 松开以添加为附件<br />
            <small>支持 txt / md / docx / doc</small>
          </div>
        </div>
      )}
    </div>
  )
}
