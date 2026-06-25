/**
 * 统一对话页面（仅 Agent 模式）· 路由 #/chat
 *
 * 现版本已废弃「快速对话」单轮流模式，所有会话默认带工具调用与多轮规划，
 * 由 useChat() 维护 Agent 单一执行策略并渲染工具卡片。
 *
 * 布局：
 *   ┌────────────────────────────────────────────┐
 *   │ 顶部：橙色像素猫 | 会话 id | Token 用量 | 新建 / 历史 / 技能 / 定时 │
 *   ├────────────────────────────────────────────┤
 *   │ 消息列表（user / assistant，可含工具卡片）  │
 *   ├────────────────────────────────────────────┤
 *   │ 输入区（textarea + 发送/停止）              │
 *   └────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useChat,
  listChatSessions,
  deleteChatSession,
  listProjects,
  createProject as createProjectIPC,
  deleteProject as deleteProjectIPC,
  renameProject as renameProjectIPC,
  pickProjectDir,
  type UIChatMessage,
} from '../hooks/useChat'
import { IPC } from '@shared/ipc-channels'
import type { ChatSessionMeta } from '@shared/types-chat'
import type { Project } from '@shared/types-project'
import { openSkills, openAgentCron } from '../hooks/useIPC'
import { ToolCallCard } from './agent/ToolCallCard'
import { AgentInput } from './agent/AgentInput'
import { useFileAttachments } from '../hooks/useFileAttachments'
import { AttachmentList } from '../components/AttachmentList'
import MessageCopyButton from '../components/MessageCopyButton'
// 复用 Agent 样式中的工具卡片 / 输入框 / 配色变量（.agent-tool-card / .agent-input / --agent-*）
import './Chat.css'

const api = window.electronAPI

export default function Chat() {
  const {
    sessionId,
    projectId,
    messages,
    running,
    fatalError,
    currentTool,
    sendMessage,
    stopGeneration,
    newSession,
    loadSession,
    switchProject,
    runSlashCommand,
  } = useChat()

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

  // 项目列表与项目管理面板
  const [projects, setProjects] = useState<Project[]>([])
  const [showProjects, setShowProjects] = useState(false)
  const reloadProjects = useCallback(async () => {
    setProjects(await listProjects())
  }, [])
  useEffect(() => {
    reloadProjects()
    // 监听项目变更广播，自动刷新
    if (!api) return
    const off = api.on(IPC.PROJECT_CHANGED, () => { reloadProjects() })
    return off
  }, [reloadProjects])

  const currentProject = useMemo(
    () => projects.find(p => p.id === projectId) ?? null,
    [projects, projectId],
  )

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

  // 打开历史抽屉时刷新：按当前项目过滤
  useEffect(() => {
    if (showSessions) {
      listChatSessions({ projectId }).then(setSessions).catch(() => setSessions([]))
    }
  }, [showSessions, projectId])

  // 上下文 Token 占比信息：取最后一条带 promptTokens metadata 的 assistant 消息
  // 用 reverse+find 风格（无 useMemo），让 React Compiler 自动决定是否记忆化
  const tokenInfo = computeTokenInfo(messages)

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    setInput('')

    // 1) 先尝试 Slash 命令分发：状态控制型在前端就地完成；模板插入型把 input 改写后再发给 LLM
    if (text.startsWith('/')) {
      const res = await runSlashCommand(text)
      if (res.handled) {
        if (res.transformedInput) {
          await sendMessage(res.transformedInput, attachments)
          clearAttachments()
        }
        return
      }
    }

    await sendMessage(text, attachments)
    clearAttachments()
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
      data-mode="agent"
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
        <div className="chat__brand" title="小小牛马 Agent">
          <span className="chat__brand-emoji">🐱</span>
          <span className="chat__brand-text">小小牛马</span>
        </div>
        {/* 项目切换器：显示当前项目，点击可切换/管理 */}
        <ProjectSwitcher
          projects={projects}
          currentId={projectId}
          disabled={running}
          onSwitch={(id) => switchProject(id)}
          onManage={() => setShowProjects(true)}
        />
        <div className="chat__session-id" title={`${currentProject?.name ?? ''} · ${sessionId}`}>#{sessionId.slice(-6)}</div>
        {tokenInfo && (
          <div
            className="chat__token-stats"
            title={`已用上下文：${tokenInfo.prompt.toLocaleString()} / ${tokenInfo.max.toLocaleString()} tokens`}
          >
            <span className="chat__token-label">🧠 Context</span>
            <div className="chat__token-bar-bg">
              <div
                className="chat__token-bar-fill"
                style={{ width: `${tokenInfo.ratio}%` }}
                data-warning={tokenInfo.ratio > 80}
              />
            </div>
            <span className="chat__token-text">{tokenInfo.ratio}%</span>
          </div>
        )}
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
          <button type="button" className="chat__btn" onClick={openSkills} title="打开技能中心">🧩 技能</button>
          <button type="button" className="chat__btn" onClick={openAgentCron} title="打开 Agent Cron">⏰ 定时</button>
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
          <EmptyState />
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
          placeholder="描述你的编程或日常任务，例如：扫描项目结构、整理今天的待办、读取代码并提建议"
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

      {showProjects && (
        <ProjectsDrawer
          projects={projects}
          currentId={projectId}
          onClose={() => setShowProjects(false)}
          onSwitch={(id) => { switchProject(id); setShowProjects(false) }}
          onReload={reloadProjects}
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
// 空状态（Agent 默认任务示例：编程 + 日常）
// ─────────────────────────────────────────────
function EmptyState() {
  const examples = [
    '扫描当前项目结构，列出主要模块',
    '帮我整理今天的待办，并写一段总结日志',
    '在桌面新建一个 todo.md，列出今天剩余任务',
    '在 src/ 下找出所有 TODO 注释',
  ]
  return (
    <div className="chat-empty">
      <div className="chat-empty__title">🐱 喵～我是能帮你写代码、跑工具的小小牛马</div>
      <div className="chat-empty__sub">描述任务，我会自动调用本地工具去执行 · 输入 <code>/help</code> 查看命令</div>
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

/**
 * 从消息列表里反向找出最近一条带 promptTokens 的 assistant 消息，计算上下文占比
 * 单独抽出后避免 useMemo + 可变循环触发 React Compiler 警告
 */
function computeTokenInfo(messages: UIChatMessage[]): { prompt: number; max: number; ratio: number } | null {
  const last = [...messages].reverse().find(m => m.role === 'assistant' && m.metadata?.promptTokens)
  const meta = last?.metadata
  if (!meta?.promptTokens) return null
  const prompt = meta.promptTokens
  const max = meta.maxTokens || 32_768
  const ratio = Math.max(0, Math.min(100, Math.round((prompt / max) * 100)))
  return { prompt, max, ratio }
}

// ─────────────────────────────────────────────
// 项目切换器（顶部）
// ─────────────────────────────────────────────
function ProjectSwitcher({ projects, currentId, disabled, onSwitch, onManage }: {
  projects: Project[]
  currentId: string
  disabled: boolean
  onSwitch: (id: string) => void
  onManage: () => void
}) {
  const current = projects.find(p => p.id === currentId)
  return (
    <div className="chat__project">
      <select
        className="chat__project-select"
        value={currentId}
        disabled={disabled}
        onChange={e => onSwitch(e.target.value)}
        title={current ? `当前项目：${current.name}\n路径：${current.path}` : '当前项目'}
      >
        {projects.length === 0 ? (
          <option value="default">默认项目</option>
        ) : (
          projects.map(p => (
            <option key={p.id} value={p.id}>📁 {p.name}</option>
          ))
        )}
      </select>
      <button
        type="button"
        className="chat__btn chat__btn--mini"
        onClick={onManage}
        title="管理项目"
      >
        ⚙
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────
// 项目管理抽屉
// ─────────────────────────────────────────────
function ProjectsDrawer({ projects, currentId, onClose, onSwitch, onReload }: {
  projects: Project[]
  currentId: string
  onClose: () => void
  onSwitch: (id: string) => void
  onReload: () => void | Promise<void>
}) {
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  // 关联本地已有目录为项目
  const handleAddExisting = async () => {
    setCreating(true)
    try {
      const dirPath = await pickProjectDir()
      if (!dirPath) return
      const name = newName.trim() || dirPath.split(/[\\/]/).pop() || '新项目'
      const res = await createProjectIPC({ name, path: dirPath, createDir: false })
      if (!res.ok) {
        alert(`创建失败：${res.error}`)
      } else {
        setNewName('')
        await onReload()
      }
    } finally {
      setCreating(false)
    }
  }

  // 在 ~/Documents/xiaoniuma 下新建项目目录
  const handleCreateDir = async () => {
    const name = newName.trim()
    if (!name) {
      alert('请先输入项目名')
      return
    }
    setCreating(true)
    try {
      const res = await createProjectIPC({ name, createDir: true })
      if (!res.ok) {
        alert(`创建失败：${res.error}`)
      } else {
        setNewName('')
        await onReload()
      }
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async (p: Project) => {
    const next = prompt(`重命名项目「${p.name}」`, p.name)
    if (!next) return
    await renameProjectIPC(p.id, next)
    await onReload()
  }

  const handleDelete = async (p: Project) => {
    if (p.id === 'default') {
      alert('默认项目不可删除')
      return
    }
    if (!confirm(`确认删除项目「${p.name}」吗？\n仅会移除索引，本地目录不会被删除；属于该项目的会话会归集到默认项目。`)) return
    await deleteProjectIPC(p.id)
    await onReload()
  }

  return (
    <div className="chat-drawer" onClick={onClose}>
      <div className="chat-drawer__panel" onClick={e => e.stopPropagation()}>
        <header className="chat-drawer__header">
          <div className="chat-drawer__title">项目管理</div>
          <button type="button" className="chat-drawer__close" onClick={onClose}>×</button>
        </header>
        <div className="chat-projects__create">
          <input
            type="text"
            className="chat-projects__input"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="项目名（用于「新建目录」时使用）"
            disabled={creating}
          />
          <button
            type="button"
            className="chat__btn"
            onClick={handleAddExisting}
            disabled={creating}
            title="关联本地已有目录为项目"
          >
            📂 关联已有
          </button>
          <button
            type="button"
            className="chat__btn"
            onClick={handleCreateDir}
            disabled={creating || !newName.trim()}
            title="在 ~/Documents/xiaoniuma/<项目名> 下新建目录"
          >
            ＋ 新建目录
          </button>
        </div>
        <div className="chat-drawer__list">
          {projects.length === 0 ? (
            <div className="chat-drawer__empty">暂无项目</div>
          ) : (
            projects.map(p => (
              <div
                key={p.id}
                className="chat-drawer__item"
                data-active={p.id === currentId}
              >
                <div className="chat-drawer__item-head">
                  <span className="chat-drawer__tag">{p.id === 'default' ? '🏠 默认' : '📁'}</span>
                  <span className="chat-drawer__item-title" title={p.path}>{p.name}</span>
                </div>
                <div className="chat-drawer__item-meta" title={p.path}>{p.path}</div>
                <div className="chat-projects__actions">
                  <button
                    type="button"
                    className="chat__btn chat__btn--mini"
                    onClick={() => onSwitch(p.id)}
                    disabled={p.id === currentId}
                  >
                    切换
                  </button>
                  <button
                    type="button"
                    className="chat__btn chat__btn--mini"
                    onClick={() => handleRename(p)}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="chat__btn chat__btn--mini chat__btn--danger"
                    onClick={() => handleDelete(p)}
                    disabled={p.id === 'default'}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
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
                    {s.mode === 'agent' ? '🤖 Agent' : '💬 旧对话'}
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
