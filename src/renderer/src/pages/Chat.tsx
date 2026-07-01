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
import {
  useChat,
  listChatSessions,
  deleteChatSession,
  listProjects,
} from '../hooks/useChat'
import { IPC } from '@shared/ipc-channels'
import type { ChatSessionMeta } from '@shared/types-chat'
import type { Project } from '@shared/types-project'
import { AgentInput } from './agent/AgentInput'
import { useFileAttachments } from '../hooks/useFileAttachments'
import { AttachmentList } from '../components/AttachmentList'
import { alert as modalAlert, confirm as modalConfirm, prompt as modalPrompt, confirmCommand as modalConfirmCommand } from '../components/Modal/Modal'
import Sidebar from '../components/chat/Sidebar'
import ChatHeader from '../components/chat/ChatHeader'
import { EmptyState } from '../components/chat/EmptyState'
import { MessageItem } from '../components/chat/MessageItem'
import Settings from './Settings'
import { computeTokenInfo } from '../utils/chat-helpers'
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
    doneAt,
    sendMessage,
    stopGeneration,
    newSession,
    loadSession,
    switchProject,
    runSlashCommand,
    regenerate,
  } = useChat()

  useLayoutEffect(() => {
    document.body.style.background = '#f7f5ef'
    return () => {
      document.body.style.background = ''
    }
  }, [])

  const [input, setInput] = useState('')
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([])
  
  // 新增：内嵌视图状态 (主聊天 / 嵌入设置页)
  const [currentView, setCurrentView] = useState<'chat' | 'settings'>('chat')



  // 加载全部会话（不传 projectId），供 Sidebar 做树状折叠分配
  const loadAllSessions = useCallback(async () => {
    try {
      const all = await listChatSessions()
      setSessions(all)
    } catch (err) {
      setSessions([])
    }
  }, [])

  useEffect(() => {
    loadAllSessions()
  }, [sessionId, projectId, loadAllSessions, doneAt])

  // 发送消息后立即刷新会话列表（占位会话已由主进程写入磁盘）
  useEffect(() => {
    if (running) loadAllSessions()
  }, [running, loadAllSessions])

  // 监听主进程的设置页激活事件 (如托盘或快捷键触发)
  useEffect(() => {
    if (!api) return
    const off = api.on('main:open-settings-view', () => {
      setCurrentView('settings')
    })
    return off
  }, [])

  // 监听快捷键 Cmd/Ctrl + , 打开设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setCurrentView('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 监听主进程发起的敏感指令二次确认请求
  useEffect(() => {
    if (!api) return

    const offConfirm = api.on(IPC.CHAT_CONFIRM_COMMAND, ((payload: { id: string; command: string; workDir?: string; timeoutMs: number; reason?: string }) => {
      void modalConfirmCommand(payload.command, payload.workDir, payload.timeoutMs, payload.reason).then(allowed => {
        api.send(IPC.CHAT_CONFIRM_COMMAND_RESPONSE, {
          id: payload.id,
          allowed
        })
      })
    }) as (...a: unknown[]) => void)

    return () => {
      offConfirm()
    }
  }, [])

  const listRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  // 拖拽计数器：避免经过子元素时 dragleave 误触发导致蒙层闪烁
  const dragCounter = useRef(0)
  // 智能滚动：是否贴底（用户未手动上滚时才自动跟随）
  const [stickToBottom, setStickToBottom] = useState(true)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  // 标记当前滚动是否由程序触发（scrollToBottom），避免 onScroll 误判为用户操作
  const isAutoScrollRef = useRef(false)

  // 监听消息列表滚动，判断是否贴底
  const handleListScroll = useCallback(() => {
    // 程序式滚动触发的事件直接跳过，不改变 stickToBottom
    if (isAutoScrollRef.current) {
      isAutoScrollRef.current = false
      return
    }
    const el = listRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance < 80
    setStickToBottom(atBottom)
    setShowScrollBtn(!atBottom && el.scrollHeight > el.clientHeight + 200)
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (!el) return
    isAutoScrollRef.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setStickToBottom(true)
    setShowScrollBtn(false)
  }, [])

  // 项目列表与项目管理面板
  const [projects, setProjects] = useState<Project[]>([])
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

  // 全局键盘快捷键：Cmd/Ctrl+N 新会话
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault()
        if (!running) { newSession(); clearAttachments() }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, newSession, clearAttachments])

  // 用户手动上滚时立即取消贴底（wheel/touchstart 比 scroll 更早捕获用户意图）
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // 向上滚动 → 用户主动查看历史，停止自动跟随
        isAutoScrollRef.current = false
        setStickToBottom(false)
      }
    }
    const onTouchStart = () => {
      // 触摸操作视为用户主动滚动，暂停自动跟随
      isAutoScrollRef.current = false
      setStickToBottom(false)
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
    }
  }, [])

  // 智能自动滚动：仅当用户贴底时才跟随，避免上滚查看历史被打断
  useEffect(() => {
    if (stickToBottom) scrollToBottom()
  }, [messages, currentTool, stickToBottom, scrollToBottom])

  // 切换会话时强制贴底
  useEffect(() => {
    setStickToBottom(true)
    setShowScrollBtn(false)
    requestAnimationFrame(() => scrollToBottom())
  }, [sessionId, scrollToBottom])



  // 上下文 Token 占比信息：取最后一条带 promptTokens metadata 的 assistant 消息
  // 用 reverse+find 风格（无 useMemo），让 React Compiler 自动决定是否记忆化
  const tokenInfo = computeTokenInfo(messages)

  /**
   * 统一的提交分发：先走 Slash 命令解析，再决定是否发给 LLM
   * 抽出后供两处调用：用户主动 Enter 提交、斜杠菜单立即提交
   */
  const submitText = useCallback(async (text: string, atts: typeof attachments) => {
    if (!text && atts.length === 0) return

    // 1) Slash 命令分发：状态控制型在前端就地完成；模板插入型把 input 改写后再发给 LLM
    if (text.startsWith('/')) {
      const res = await runSlashCommand(text)
      if (res.handled) {
        if (res.transformedInput) {
          await sendMessage(res.transformedInput, atts)
          clearAttachments()
        }
        return
      }
    }

    await sendMessage(text, atts)
    clearAttachments()
  }, [runSlashCommand, sendMessage, clearAttachments])

  const handleSubmit = async () => {
    const text = input.trim()
    if (!text && attachments.length === 0) return
    setInput('')
    await submitText(text, attachments)
  }

  /** 斜杠菜单 immediate 命令的立即提交回调（如 /help、/compact） */
  const handleInstantSubmit = useCallback((text: string) => {
    void submitText(text.trim(), attachments)
  }, [submitText, attachments])

  // 计算最后一条 assistant 消息 id，仅对该消息显示重新生成按钮
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].iteration !== -1) return messages[i].id
    }
    return null
  }, [messages])

  return (
    <div
      className={`codex-layout ${dragOver ? 'drag-over' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        dragCounter.current++
        if (!dragOver) setDragOver(true)
      }}
      onDragOver={(e) => { e.preventDefault() }}
      onDragLeave={(e) => {
        e.preventDefault()
        dragCounter.current--
        if (dragCounter.current <= 0) {
          dragCounter.current = 0
          setDragOver(false)
        }
      }}
      onDrop={async (e) => {
        e.preventDefault()
        dragCounter.current = 0
        setDragOver(false)
        await addFilesFromDrop(e.dataTransfer.files)
      }}
    >
      {/* 左侧侧边栏 (常驻) */}
      <Sidebar
        projects={projects}
        currentProjectId={projectId}
        currentSessionId={sessionId}
        sessions={sessions}
        onSwitchProject={(id) => {
          setCurrentView('chat')
          switchProject(id)
        }}
        onLoadSession={(id) => {
          setCurrentView('chat')
          clearAttachments()
          loadSession(id)
        }}
        onNewSession={() => {
          setCurrentView('chat')
          clearAttachments()
          newSession()
        }}
        onOpenSettings={() => setCurrentView('settings')}
        onProjectsChanged={reloadProjects}
        onSearchClick={() => setInput('/')}
      />

      {/* 右侧主显示区 */}
      <div className="codex-main-pane">
        {currentView === 'chat' ? (
          <>
            <ChatHeader
              title={currentProject ? `${currentProject.name} · 任务` : '小小牛马'}
              running={running}
              tokenInfo={tokenInfo}
              onRename={async () => {
                const newTitle = await modalPrompt('请输入新任务标题：', currentProject?.name ?? '', '重命名会话')
                if (newTitle?.trim()) {
                  await window.electronAPI.invoke(IPC.CHAT_RENAME_SESSION, { id: sessionId, title: newTitle.trim() })
                  loadAllSessions()
                }
              }}
              onCompact={async () => {
                const confirmRes = await modalConfirm('物理压缩将总结较早的对话历史以节省上下文空间。是否继续？', '物理压缩会话')
                if (confirmRes) {
                  const res = await window.electronAPI.invoke(IPC.CHAT_COMPACT_SESSION, sessionId) as { ok: boolean; error?: string; removed?: number }
                  if (res.ok) {
                    await modalAlert(`压缩成功！已用 LLM 摘要替换了 ${res.removed} 条早期消息。`, '压缩成功')
                    loadSession(sessionId)
                  } else {
                    await modalAlert(`压缩失败：${res.error}`, '压缩失败')
                  }
                }
              }}
              onDelete={async () => {
                const confirmRes = await modalConfirm('确定要删除这个会话及其全部历史吗？此操作无法撤销。', '删除确认', true)
                if (confirmRes) {
                  await deleteChatSession(sessionId)
                  newSession()
                  loadAllSessions()
                }
              }}
            />

            {fatalError && (
              <div className="chat__error">❌ {fatalError}</div>
            )}

            {currentTool && (
              <div className="chat__statusbar">
                <span className="chat__spinner" />
                正在执行工具：<code>{currentTool}</code>
              </div>
            )}

            <main className="chat__list" ref={listRef} onScroll={handleListScroll}>
              {messages.length === 0 ? (
                <EmptyState />
              ) : (
                messages.map(m => <MessageItem key={m.id} message={m} onRegenerate={m.id === lastAssistantId ? regenerate : undefined} canRegenerate={!running} />)
              )}
            </main>

            {/* 回到底部悬浮按钮 */}
            {showScrollBtn && (
              <button
                type="button"
                className="chat__scroll-bottom"
                onClick={() => scrollToBottom(true)}
                aria-label="回到底部"
                title="回到底部"
              >
                ↓
              </button>
            )}

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
                onInstantSubmit={handleInstantSubmit}
                onStop={stopGeneration}
                running={running}
                onPickFiles={pickFiles}
                isReadingFiles={isReading}
                placeholder="描述你的编程或日常任务，例如：扫描项目结构、整理今天的待办、读取代码并提建议"
              />
            </footer>
          </>
        ) : (
          <>
            {/* 设置视图顶栏 */}
            <header className="codex-header" style={{ paddingLeft: '20px' }}>
              <div className="codex-header__title-group">
                <button type="button" className="settings-back-btn" onClick={() => setCurrentView('chat')}>
                  ◀ 返回聊天
                </button>
                <h2 className="codex-header__title">设置中心</h2>
              </div>
              <div className="codex-header__drag-area" />
              <button
                type="button"
                className="codex-header__window-close"
                onClick={() => window.electronAPI.send(IPC.CHAT_CLOSE_WINDOW)}
                aria-label="关闭窗口"
                title="关闭"
              >
                ×
              </button>
            </header>
            
            {/* 设置表单内嵌滚动容器 */}
            <div className="settings-view-scroll">
              <Settings />
            </div>
          </>
        )}
      </div>

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


