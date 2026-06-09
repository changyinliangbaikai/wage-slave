/**
 * Agent 模式对话页面（Phase 1）
 *
 * 与 AIChat 并存的独立窗口，路由 #/agent。
 *
 * 布局：
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 顶部：标题 + 当前会话 + 新建/历史/设置                │
 *   ├──────────────────────────────────────────────────────┤
 *   │                                                      │
 *   │ 消息列表（user / assistant 自带工具调用卡片）        │
 *   │                                                      │
 *   ├──────────────────────────────────────────────────────┤
 *   │ AgentInput（textarea + 发送/停止）                    │
 *   └──────────────────────────────────────────────────────┘
 *
 * 不复用 AIChat.tsx 70KB 的实现，独立做以保持 Agent 体验自由演进。
 */

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useAgent,
  listAgentSessions,
  deleteAgentSession,
  type UIAgentMessage,
} from '../hooks/useAgent'
import { openAgentCron, openSkills } from '../hooks/useIPC'
import type { AgentSessionMeta } from '@shared/types'
import { ToolCallCard } from './agent/ToolCallCard'
import { AgentInput } from './agent/AgentInput'
import './AgentChat.css'

export default function AgentChat() {
  const {
    sessionId,
    messages,
    running,
    fatalError,
    currentTool,
    sendTask,
    stopTask,
    newSession,
    loadSession,
  } = useAgent()

  const [input, setInput] = useState('')
  const [showSessions, setShowSessions] = useState(false)
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  // 自动滚到底部
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, currentTool])

  // 打开历史抽屉时刷新列表
  useEffect(() => {
    if (showSessions) {
      listAgentSessions().then(setSessions).catch(() => setSessions([]))
    }
  }, [showSessions])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    await sendTask(text)
  }

  const handleSessionClick = async (id: string) => {
    setShowSessions(false)
    await loadSession(id)
  }

  const handleSessionDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const ok = await deleteAgentSession(id)
    if (ok) setSessions(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div className="agent-chat">
      <header className="agent-chat__header">
        <div className="agent-chat__title">
          <span className="agent-chat__title-emoji">🤖</span>
          <span className="agent-chat__title-text">Agent 模式</span>
          <span className="agent-chat__session-id" title={sessionId}>
            {sessionId.slice(-8)}
          </span>
        </div>
        <div className="agent-chat__actions">
          <button type="button" className="agent-chat__btn" onClick={newSession} disabled={running}>
            ＋ 新会话
          </button>
          <button type="button" className="agent-chat__btn" onClick={() => setShowSessions(true)}>
            历史
          </button>
          <button type="button" className="agent-chat__btn" onClick={openSkills} title="打开技能中心">
            🧩 技能
          </button>
          <button type="button" className="agent-chat__btn" onClick={openAgentCron} title="打开 Agent Cron">
            ⏰ 定时
          </button>
        </div>
      </header>

      {fatalError && (
        <div className="agent-chat__error">
          <span>❌ {fatalError}</span>
        </div>
      )}

      {currentTool && (
        <div className="agent-chat__statusbar">
          <span className="agent-chat__spinner" />
          正在执行工具：<code>{currentTool}</code>
        </div>
      )}

      <main className="agent-chat__list" ref={listRef}>
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          messages.map(m => <MessageItem key={m.id} message={m} />)
        )}
      </main>

      <footer className="agent-chat__footer">
        <AgentInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onStop={stopTask}
          running={running}
        />
      </footer>

      {showSessions && (
        <SessionsDrawer
          sessions={sessions}
          currentId={sessionId}
          onClose={() => setShowSessions(false)}
          onPick={handleSessionClick}
          onDelete={handleSessionDelete}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// 空状态
// ─────────────────────────────────────────────

function EmptyState() {
  const examples = [
    '帮我看看今天有哪些待办，按优先级整理',
    '把今天完成的事情写一段简短的日志',
    '在桌面新建一个 todo.md，列出今天剩余任务',
    '搜索 Documents 目录里包含 "周报" 的所有 md 文件',
  ]
  return (
    <div className="agent-empty">
      <div className="agent-empty__title">🐱 喵～我是小小牛马，能帮你干活的 Agent</div>
      <div className="agent-empty__sub">告诉我你想完成什么，我会自动调用本地工具去执行</div>
      <div className="agent-empty__examples">
        {examples.map(e => (
          <div key={e} className="agent-empty__example">{e}</div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────
// 消息项
// ─────────────────────────────────────────────

function MessageItem({ message }: { message: UIAgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="agent-msg agent-msg--user">
        <div className="agent-msg__bubble">{message.content}</div>
      </div>
    )
  }

  if (message.role === 'assistant') {
    return (
      <div className="agent-msg agent-msg--assistant">
        <div className="agent-msg__avatar">🐱</div>
        <div className="agent-msg__body">
          {message.reasoning && (
            <ReasoningBlock content={message.reasoning} />
          )}
          {message.toolRuns && message.toolRuns.length > 0 && (
            <div className="agent-msg__tools">
              {message.toolRuns.map(run => (
                <ToolCallCard key={run.id} run={run} />
              ))}
            </div>
          )}
          {message.content && (
            <div className="agent-msg__content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
          {message.streaming && !message.content && !message.toolRuns?.length && (
            <div className="agent-msg__placeholder">
              <span className="agent-chat__spinner" /> 思考中...
            </div>
          )}
        </div>
      </div>
    )
  }

  return null  // tool 消息已被吸收到 assistant.toolRuns
}

function ReasoningBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="agent-reasoning"
      open={open}
      onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>💭 推理过程（{content.length} 字）</summary>
      <pre className="agent-reasoning__pre">{content}</pre>
    </details>
  )
}

// ─────────────────────────────────────────────
// 历史会话抽屉
// ─────────────────────────────────────────────

function SessionsDrawer({
  sessions,
  currentId,
  onClose,
  onPick,
  onDelete,
}: {
  sessions: AgentSessionMeta[]
  currentId: string
  onClose: () => void
  onPick: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
}) {
  return (
    <div className="agent-drawer" onClick={onClose}>
      <div className="agent-drawer__panel" onClick={e => e.stopPropagation()}>
        <header className="agent-drawer__header">
          <div className="agent-drawer__title">历史会话</div>
          <button type="button" className="agent-drawer__close" onClick={onClose}>×</button>
        </header>
        <div className="agent-drawer__list">
          {sessions.length === 0 ? (
            <div className="agent-drawer__empty">暂无历史会话</div>
          ) : (
            sessions.map(s => (
              <button
                key={s.id}
                type="button"
                className="agent-drawer__item"
                data-active={s.id === currentId}
                onClick={() => onPick(s.id)}
              >
                <div className="agent-drawer__item-title">{s.title}</div>
                <div className="agent-drawer__item-meta">
                  {new Date(s.updatedAt).toLocaleString('zh-CN')} · {s.messageCount} 条
                </div>
                <div className="agent-drawer__item-preview">{s.preview}</div>
                <span
                  className="agent-drawer__item-delete"
                  onClick={(e) => onDelete(s.id, e)}
                  title="删除"
                  role="button"
                >
                  ×
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
