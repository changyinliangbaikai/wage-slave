/**
 * 统一对话页面（AI 对话 + Agent 模式合并）· 路由 #/chat
 *
 * 顶部可在「快速对话 / Agent 模式」之间切换；同一套消息列表 + 输入框，
 * 由 useChat() 根据 mode 自动选择底层执行策略并渲染（Agent 模式额外展示工具卡片）。
 *
 * 布局：
 *   ┌────────────────────────────────────────────┐
 *   │ 顶部：模式切换 | 会话 id | 新建 / 历史 / 技能 │
 *   ├────────────────────────────────────────────┤
 *   │ 消息列表（user / assistant，可含工具卡片）   │
 *   ├────────────────────────────────────────────┤
 *   │ 输入区（textarea + 发送/停止）               │
 *   └────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useChat,
  listChatSessions,
  deleteChatSession,
  type UIChatMessage,
} from '../hooks/useChat'
import type { ChatMode, ChatSessionMeta } from '@shared/types-chat'
import { openSkills, openAgentCron } from '../hooks/useIPC'
import { ToolCallCard } from './agent/ToolCallCard'
import { AgentInput } from './agent/AgentInput'
import { useFileAttachments } from '../hooks/useFileAttachments'
import { AttachmentList } from '../components/AttachmentList'
import MessageCopyButton from '../components/MessageCopyButton'
// 复用 Agent 样式中的工具卡片 / 输入框 / 配色变量（.agent-tool-card / .agent-input / --agent-*）
import './Chat.css'

export default function Chat() {
  const {
    sessionId,
    mode,
    messages,
    running,
    fatalError,
    currentTool,
    sendMessage,
    stopGeneration,
    newSession,
    loadSession,
    switchMode,
  } = useChat('chat')

  useLayoutEffect(() => {
    document.body.style.background = '#f7f5ef'
    return () => {
      document.body.style.background = ''
    }
  }, [])

  const [input, setInput] = useState('')
  const [showSessions, setShowSessions] = useState(false)
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)

  // 使用统一的文件附件 Hook
  const {
    attachments,
    isReading,
    pickFiles,
    addFilesFromDrop,
    removeAttachment,
    clearAttachments,
  } = useFileAttachments()

  // 自动滚到底部
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, currentTool])

  // 打开历史抽屉时刷新
  useEffect(() => {
    if (showSessions) listChatSessions().then(setSessions).catch(() => setSessions([]))
  }, [showSessions])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    setInput('')
    await sendMessage(text, attachments)
    clearAttachments() // 发送后清空附件
  }

  const handlePick = async (id: string) => {
    setShowSessions(false)
    clearAttachments() // 切换会话时清空附件
    await loadSession(id)
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await deleteChatSession(id)
    if (ok) setSessions(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div
      className={`chat ${dragOver ? 'drag-over' : ''}`}
      data-mode={mode}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        if (e.target === e.currentTarget) setDragOver(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setDragOver(false)
        await addFilesFromDrop(e.dataTransfer.files)
      }}
    >
      <header className="chat__header">
        <ModeSwitch
          mode={mode}
          disabled={running}
          onChange={(m) => {
            switchMode(m)
            clearAttachments() // 切换模式时清空附件
          }}
        />
        <div className="chat__session-id" title={sessionId}>#{sessionId.slice(-6)}</div>
        <div className="chat__actions">
          <button
            type="button"
            className="chat__btn"
            onClick={() => {
              newSession()
              clearAttachments() // 新建会话时清空附件
            }}
            disabled={running}
          >
            ＋ 新会话
          </button>
          <button type="button" className="chat__btn" onClick={() => setShowSessions(true)}>
            历史
          </button>
          {mode === 'agent' && (
            <>
              <button type="button" className="chat__btn" onClick={openSkills} title="打开技能中心">🧩 技能</button>
              <button type="button" className="chat__btn" onClick={openAgentCron} title="打开 Agent Cron">⏰ 定时</button>
            </>
          )}
        </div>
      </header>

      {fatalError && (
        <div className="chat__error">❌ {fatalError}</div>
      )}

      {currentTool && (
        <div className="chat__statusbar">
          <span className="chat__spinner" />
          正在执行工具：<code>{currentTool}</code>
        </div>
      )}

      <main className="chat__list" ref={listRef}>
        {messages.length === 0 ? (
          <EmptyState mode={mode} />
        ) : (
          messages.map(m => <MessageItem key={m.id} message={m} />)
        )}
      </main>

      <footer className="chat__footer">
        {/* 附件列表 */}
        <AttachmentList
          attachments={attachments}
          onRemove={removeAttachment}
        />
        <AgentInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onStop={stopGeneration}
          running={running}
          onPickFiles={pickFiles}
          isReadingFiles={isReading}
          placeholder={mode === 'agent'
            ? '描述你想完成的任务，例如：帮我整理今天的待办并写入日志'
            : '问点什么吧，例如：帮我把这段话润色一下'}
        />
      </footer>

      {showSessions && (
        <SessionsDrawer
          sessions={sessions}
          currentId={sessionId}
          onClose={() => setShowSessions(false)}
          onPick={handlePick}
          onDelete={handleDelete}
        />
      )}

      {/* 拖拽蒙层 */}
      {dragOver && (
        <div className="chat-drag-overlay">
          <div className="chat-drag-hint">
            📎 松开以添加为附件<br />
            <small>支持 txt / md / docx / doc</small>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// 模式切换
// ─────────────────────────────────────────────
function ModeSwitch({ mode, disabled, onChange }: {
  mode: ChatMode
  disabled: boolean
  onChange: (m: ChatMode) => void
}) {
  return (
    <div className="chat__modeswitch" role="tablist" aria-label="对话模式">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'chat'}
        className="chat__mode"
        data-active={mode === 'chat'}
        disabled={disabled}
        onClick={() => onChange('chat')}
      >
        💬 快速对话
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'agent'}
        className="chat__mode"
        data-active={mode === 'agent'}
        disabled={disabled}
        onClick={() => onChange('agent')}
      >
        🤖 Agent
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────
// 空状态
// ─────────────────────────────────────────────
function EmptyState({ mode }: { mode: ChatMode }) {
  const examples = mode === 'agent'
    ? [
        '帮我看看今天有哪些待办，按优先级整理',
        '把今天完成的事情写一段简短的日志',
        '在桌面新建一个 todo.md，列出今天剩余任务',
      ]
    : [
        '帮我把这段话润色得更正式一些',
        '用一句话解释什么是事件循环',
        '把下面这段中文翻译成英文',
      ]
  return (
    <div className="chat-empty">
      <div className="chat-empty__title">
        {mode === 'agent' ? '🐱 喵～我是能帮你干活的 Agent' : '🐱 喵～有什么可以帮你的'}
      </div>
      <div className="chat-empty__sub">
        {mode === 'agent' ? '描述任务，我会自动调用本地工具去执行' : '随便聊聊，或试试下面的例子'}
      </div>
      <div className="chat-empty__examples">
        {examples.map(e => <div key={e} className="chat-empty__example">{e}</div>)}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// 消息项
// ─────────────────────────────────────────────
function MessageItem({ message }: { message: UIChatMessage }) {
  const copyText = getMessageCopyText(message)

  if (message.role === 'user') {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-msg__bubble">
          <MessageCopyButton text={copyText} />
          {message.content}
          {/* 显示附件列表 */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="chat-msg__attachments">
              {message.attachments.map(att => (
                <span key={att.id} className="chat-msg__attachment" title={att.fileName}>
                  📎 {att.fileName} {att.truncated && '(已截取)'}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (message.role === 'assistant') {
    return (
      <div className="chat-msg chat-msg--assistant">
        <div className="chat-msg__avatar">🐱</div>
        <div className="chat-msg__body">
          {message.reasoning && <ReasoningBlock content={message.reasoning} />}
          {message.toolRuns && message.toolRuns.length > 0 && (
            <div className="chat-msg__tools">
              {message.toolRuns.map(run => <ToolCallCard key={run.id} run={run} />)}
            </div>
          )}
          {message.content && (
            <div className="chat-msg__content">
              <MessageCopyButton text={copyText} />
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
          {message.streaming && !message.content && !message.toolRuns?.length && (
            <div className="chat-msg__placeholder">
              <span className="chat__spinner" /> 思考中...
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

function getMessageCopyText(message: UIChatMessage): string {
  const parts: string[] = []
  if (message.content.trim()) parts.push(message.content)
  if (message.attachments?.length) {
    parts.push(message.attachments.map(att => `[附件] ${att.fileName}`).join('\n'))
  }
  return parts.join('\n\n')
}

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="chat-reasoning" open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>💭 推理过程（{content.length} 字）</summary>
      <pre className="chat-reasoning__pre">{content}</pre>
    </details>
  )
}

// ─────────────────────────────────────────────
// 历史会话抽屉
// ─────────────────────────────────────────────
function SessionsDrawer({ sessions, currentId, onClose, onPick, onDelete }: {
  sessions: ChatSessionMeta[]
  currentId: string
  onClose: () => void
  onPick: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
}) {
  return (
    <div className="chat-drawer" onClick={onClose}>
      <div className="chat-drawer__panel" onClick={e => e.stopPropagation()}>
        <header className="chat-drawer__header">
          <div className="chat-drawer__title">历史会话</div>
          <button type="button" className="chat-drawer__close" onClick={onClose}>×</button>
        </header>
        <div className="chat-drawer__list">
          {sessions.length === 0 ? (
            <div className="chat-drawer__empty">暂无历史会话</div>
          ) : (
            sessions.map(s => (
              <button
                key={s.id}
                type="button"
                className="chat-drawer__item"
                data-active={s.id === currentId}
                onClick={() => onPick(s.id)}
              >
                <div className="chat-drawer__item-head">
                  <span className="chat-drawer__tag" data-mode={s.mode}>
                    {s.mode === 'agent' ? '🤖 Agent' : '💬 对话'}
                  </span>
                  <span className="chat-drawer__item-title">{s.title}</span>
                </div>
                <div className="chat-drawer__item-meta">
                  {new Date(s.updatedAt).toLocaleString('zh-CN')} · {s.messageCount} 条
                </div>
                <div className="chat-drawer__item-preview">{s.preview}</div>
                <span
                  className="chat-drawer__item-delete"
                  onClick={(e) => onDelete(s.id, e)}
                  title="删除"
                  role="button"
                >×</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
