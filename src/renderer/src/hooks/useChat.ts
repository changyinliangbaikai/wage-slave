/**
 * 统一对话状态管理 Hook（合并 AI 对话 + Agent 模式）
 *
 * 一个 Hook 同时支撑两种执行策略，由 `mode` 决定：
 *   - 'chat'  ：单轮流式，一条 assistant 消息按 messageId 流式更新
 *   - 'agent' ：多轮迭代，每轮一条 assistant（按 iteration 区分），携带工具卡片
 *
 * 与主进程通过统一的 CHAT_* 通道通信：
 *   CHAT_START / CHAT_STOP / CHAT_CHUNK / CHAT_TOOL_EVENT / CHAT_DONE / CHAT_ERROR
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
  ChatMode,
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ChatChunkPayload,
  ChatToolEventPayload,
  ChatDonePayload,
  ChatErrorPayload,
  ChatStartParams,
  ChatStartResult,
} from '@shared/types-chat'

const DESKTOP_API_UNAVAILABLE = '当前页面未连接桌面端能力，请在小小牛马桌面应用窗口中使用对话。'

const unavailableApi: Window['electronAPI'] = {
  invoke: async () => { throw new Error(DESKTOP_API_UNAVAILABLE) },
  send: () => {},
  sendRaw: () => {},
  on: () => () => {},
}

const api = window.electronAPI ?? unavailableApi

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** 生成带模式前缀的会话 id（与主进程 chat-store 路由约定一致） */
function genSessionId(mode: ChatMode): string {
  const rand = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return mode === 'agent' ? `agent_${rand}` : `chat_${rand}`
}

/** 工具调用 UI 状态（与 ToolCallCard 对齐） */
export interface ToolRunUI {
  id: string
  name: string
  description: string
  safetyLevel?: 'safe' | 'cautious' | 'sensitive'
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  output?: string
  error?: string
  durationMs?: number
}

/** 渲染端消息：在统一 ChatMessage 上叠加 UI 态 */
export interface UIChatMessage extends ChatMessage {
  /** assistant 本轮发起的工具调用（Agent 模式） */
  toolRuns?: ToolRunUI[]
  /** 是否仍在流式生成 */
  streaming?: boolean
  /** Agent 模式：第几轮迭代 */
  iteration?: number
}

export interface UseChatResult {
  sessionId: string
  mode: ChatMode
  messages: UIChatMessage[]
  running: boolean
  fatalError: string | null
  currentTool: string | null
  sendMessage: (content: string) => Promise<void>
  stopGeneration: () => Promise<void>
  newSession: (mode?: ChatMode) => void
  loadSession: (id: string) => Promise<void>
  switchMode: (mode: ChatMode) => void
}

export function useChat(initialMode: ChatMode = 'chat'): UseChatResult {
  const [mode, setMode] = useState<ChatMode>(initialMode)
  const [sessionId, setSessionId] = useState<string>(() => genSessionId(initialMode))
  const [messages, setMessages] = useState<UIChatMessage[]>([])
  const [running, setRunning] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [currentTool, setCurrentTool] = useState<string | null>(null)

  // 事件回调里读最新值，避免闭包陷阱
  const sessionIdRef = useRef(sessionId)
  const modeRef = useRef(mode)
  const messagesRef = useRef(messages)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // ── 简单对话：按 messageId 更新单条 assistant ──
  const patchMessageById = useCallback((id: string, patch: Partial<UIChatMessage>) => {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)))
  }, [])

  // ── Agent：按 iteration 维护流式 assistant ──
  const upsertStreamingAssistant = useCallback((iteration: number, content: string, reasoning: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.iteration === iteration && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content, reasoning }]
      }
      const next: UIChatMessage = {
        id: genId('asst'),
        role: 'assistant',
        content,
        reasoning: reasoning || undefined,
        createdAt: Date.now(),
        toolRuns: [],
        streaming: true,
        iteration,
      }
      return [...prev, next]
    })
  }, [])

  const attachToolRuns = useCallback((iteration: number, toolCalls: NonNullable<ChatToolEventPayload['toolCalls']>) => {
    const newRuns: ToolRunUI[] = toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      description: tc.description,
      safetyLevel: tc.safetyLevel,
      arguments: tc.arguments,
      status: 'pending',
    }))
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]
        if (m.role === 'assistant' && m.iteration === iteration) {
          return [...prev.slice(0, i), { ...m, toolRuns: [...(m.toolRuns ?? []), ...newRuns] }, ...prev.slice(i + 1)]
        }
      }
      return prev
    })
  }, [])

  const updateToolRun = useCallback((toolId: string, patch: Partial<ToolRunUI>) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]
        if (m.role !== 'assistant' || !m.toolRuns) continue
        const idx = m.toolRuns.findIndex(t => t.id === toolId)
        if (idx === -1) continue
        const runs = [...m.toolRuns]
        runs[idx] = { ...runs[idx], ...patch }
        return [...prev.slice(0, i), { ...m, toolRuns: runs }, ...prev.slice(i + 1)]
      }
      return prev
    })
  }, [])

  // ── 简单对话：完成后持久化（Agent 由主进程自动持久化） ──
  const persistChatSession = useCallback((msgs: UIChatMessage[]) => {
    if (msgs.length === 0) return
    const firstUser = msgs.find(m => m.role === 'user')
    const title = (firstUser?.content ?? '新会话').slice(0, 24) || '新会话'
    const preview = (firstUser?.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
    const now = Date.now()
    const session: ChatSession = {
      id: sessionIdRef.current,
      title,
      createdAt: msgs[0]?.createdAt ?? now,
      updatedAt: now,
      messageCount: msgs.length,
      preview,
      mode: 'chat',
      messages: msgs.map(({ toolRuns: _t, streaming: _s, iteration: _i, ...rest }) => rest),
      config: { mode: 'chat' },
    }
    api.invoke(IPC.CHAT_SAVE_SESSION, session).catch(() => { /* 保存失败不阻塞 UI */ })
  }, [])

  // ── 发送消息 ──────────────────────────────────
  const sendMessage = useCallback(async (content: string) => {
    const trimmed = content.trim()
    if (!trimmed || running) return

    const id = sessionIdRef.current
    const curMode = modeRef.current

    const userMsg: UIChatMessage = {
      id: genId('user'), role: 'user', content: trimmed, createdAt: Date.now(),
    }
    const assistantId = genId('asst')

    setRunning(true)
    setFatalError(null)
    setCurrentTool(null)

    // chat 模式预插入一条 assistant 占位用于流式；agent 模式由 iteration 流程动态插入
    if (curMode === 'chat') {
      const assistantMsg: UIChatMessage = {
        id: assistantId, role: 'assistant', content: '', reasoning: '', streaming: true, createdAt: Date.now(),
      }
      setMessages(prev => [...prev, userMsg, assistantMsg])
    } else {
      setMessages(prev => [...prev, userMsg])
    }

    // chat 模式需要把历史一并带给主进程（仅 role/content）
    const history = curMode === 'chat'
      ? messagesRef.current
          .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
          .map(m => ({ role: m.role, content: m.content }))
      : undefined

    const params: ChatStartParams = {
      sessionId: id,
      mode: curMode,
      userInput: trimmed,
      assistantMessageId: curMode === 'chat' ? assistantId : undefined,
      history,
    }

    const fail = (msg: string) => {
      setRunning(false)
      setFatalError(msg)
      // 结束流式占位，避免 assistant 一直显示「思考中」
      setMessages(prev => prev.map(m => (m.streaming ? { ...m, streaming: false } : m)))
    }

    try {
      const res = (await api.invoke(IPC.CHAT_START, params)) as ChatStartResult
      if (!res?.ok) fail(res?.error ?? '启动失败')
    } catch (e) {
      fail(errMsg(e, '启动失败'))
    }
  }, [running])

  const stopGeneration = useCallback(async () => {
    try {
      await api.invoke(IPC.CHAT_STOP, { sessionId: sessionIdRef.current })
    } catch { /* 任务已结束或桥不可用 */ }
  }, [])

  const newSession = useCallback((nextMode?: ChatMode) => {
    if (running) return
    const m = nextMode ?? modeRef.current
    setMode(m)
    setSessionId(genSessionId(m))
    setMessages([])
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  /** 切换模式：开启该模式下的新会话（mode 是会话级配置） */
  const switchMode = useCallback((nextMode: ChatMode) => {
    if (running || nextMode === modeRef.current) return
    newSession(nextMode)
  }, [running, newSession])

  const loadSession = useCallback(async (id: string) => {
    if (running) return
    let session: ChatSession | null = null
    try {
      session = (await api.invoke(IPC.CHAT_GET_SESSION, id)) as ChatSession | null
    } catch (e) {
      setFatalError(errMsg(e, '加载历史会话失败'))
      return
    }
    if (!session) return
    setMode(session.mode)
    setSessionId(id)
    setMessages(projectMessagesToUI(session.messages, session.mode))
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  // ── IPC 事件订阅 ─────────────────────────────
  useEffect(() => {
    const mine = (sid: string) => sid === sessionIdRef.current

    const offChunk = api.on(IPC.CHAT_CHUNK, ((p: ChatChunkPayload) => {
      if (!mine(p.sessionId)) return
      if (typeof p.iteration === 'number') {
        upsertStreamingAssistant(p.iteration, p.content, p.reasoning)
      } else if (p.messageId) {
        patchMessageById(p.messageId, { content: p.content, reasoning: p.reasoning })
      }
    }) as (...a: unknown[]) => void)

    const offTool = api.on(IPC.CHAT_TOOL_EVENT, ((p: ChatToolEventPayload) => {
      if (!mine(p.sessionId)) return
      if (p.phase === 'start' && typeof p.iteration === 'number' && p.toolCalls) {
        attachToolRuns(p.iteration, p.toolCalls)
      } else if (p.phase === 'executing' && p.toolId) {
        setCurrentTool(p.toolName ?? null)
        updateToolRun(p.toolId, { status: 'running' })
      } else if (p.phase === 'executed' && p.toolId) {
        setCurrentTool(null)
        updateToolRun(p.toolId, {
          status: p.success ? 'success' : 'error',
          output: p.output,
          error: p.error,
          durationMs: p.durationMs,
        })
      }
    }) as (...a: unknown[]) => void)

    const offDone = api.on(IPC.CHAT_DONE, ((p: ChatDonePayload) => {
      if (!mine(p.sessionId)) return
      setRunning(false)
      setCurrentTool(null)
      let finalMsgs: UIChatMessage[] = []
      setMessages(prev => {
        const next = prev.map((m, idx) => {
          // chat 模式：定位 messageId；agent 模式：收尾最后一条 streaming assistant
          const isTarget = p.messageId
            ? m.id === p.messageId
            : idx === prev.length - 1 && m.role === 'assistant' && m.streaming
          if (!isTarget) return m
          return { ...m, streaming: false, content: p.content || m.content, reasoning: p.reasoning ?? m.reasoning, stats: p.stats ?? m.stats }
        })
        finalMsgs = next
        return next
      })
      // chat 模式由渲染端持久化；agent 模式主进程已自动持久化
      if (modeRef.current === 'chat') {
        setTimeout(() => persistChatSession(finalMsgs), 0)
      }
    }) as (...a: unknown[]) => void)

    const offError = api.on(IPC.CHAT_ERROR, ((p: ChatErrorPayload) => {
      if (!mine(p.sessionId)) return
      if (p.fatal) {
        setRunning(false)
        setCurrentTool(null)
        setFatalError(p.error)
        // 把流式占位标记结束，避免一直转圈
        setMessages(prev => prev.map(m => (m.streaming ? { ...m, streaming: false } : m)))
      }
    }) as (...a: unknown[]) => void)

    return () => { offChunk(); offTool(); offDone(); offError() }
  }, [upsertStreamingAssistant, attachToolRuns, updateToolRun, patchMessageById, persistChatSession])

  return {
    sessionId, mode, messages, running, fatalError, currentTool,
    sendMessage, stopGeneration, newSession, loadSession, switchMode,
  }
}

// ─────────────────────────────────────────────
// 历史消息投影：把扁平存储消息转为带 toolRuns 的 UI 消息
// ─────────────────────────────────────────────
function projectMessagesToUI(messages: ChatMessage[], mode: ChatMode): UIChatMessage[] {
  if (mode === 'chat') {
    return messages.filter(m => m.role !== 'tool').map(m => ({ ...m }))
  }

  // agent：role=tool 的结果回填到对应 assistant 的 toolRuns
  const ui: UIChatMessage[] = []
  const toolResult = new Map<string, { output?: string; error?: string }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      const isErr = m.content.startsWith('[ERROR]')
      toolResult.set(m.tool_call_id, isErr ? { error: m.content.slice(7).trim() } : { output: m.content })
    }
  }
  for (const m of messages) {
    if (m.role === 'tool') continue
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const toolRuns: ToolRunUI[] = m.tool_calls.map(tc => {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(tc.arguments) as Record<string, unknown> } catch { /* ignore */ }
        const r = toolResult.get(tc.id)
        return {
          id: tc.id,
          name: tc.name,
          description: '',
          safetyLevel: inferToolSafety(tc.name),
          arguments: parsed,
          status: r?.error ? 'error' : 'success',
          output: r?.output,
          error: r?.error,
        }
      })
      ui.push({ ...m, toolRuns, streaming: false })
    } else {
      ui.push({ ...m })
    }
  }
  return ui
}

function inferToolSafety(name: string): ToolRunUI['safetyLevel'] {
  if (['read_file', 'list_files', 'search_files', 'get_today_log', 'get_todos', 'get_logs_range', 'scheduler_list_tasks', 'wait'].includes(name)) {
    return 'safe'
  }
  if (['run_command', 'open_file'].includes(name)) return 'sensitive'
  return 'cautious'
}

// ── 会话列表/管理（暴露给页面） ────────────────
export async function listChatSessions(): Promise<ChatSessionMeta[]> {
  try {
    return (await api.invoke(IPC.CHAT_LIST_SESSIONS)) as ChatSessionMeta[]
  } catch {
    return []
  }
}

export async function deleteChatSession(id: string): Promise<boolean> {
  try {
    const r = (await api.invoke(IPC.CHAT_DELETE_SESSION, id)) as { ok: boolean }
    return Boolean(r?.ok)
  } catch {
    return false
  }
}

export async function renameChatSession(id: string, title: string): Promise<boolean> {
  try {
    const r = (await api.invoke(IPC.CHAT_RENAME_SESSION, { id, title })) as { ok: boolean }
    return Boolean(r?.ok)
  } catch {
    return false
  }
}
