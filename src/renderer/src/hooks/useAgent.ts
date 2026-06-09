/**
 * Agent 模式状态管理 Hook
 *
 * 责任：
 *  1. 维护一个会话的消息列表 + 工具调用面板
 *  2. 把 IPC 流式增量翻译成 React state
 *  3. 暴露 sendTask / stopTask / loadSession 三个核心动作
 *
 * 设计：
 *  - sessionId 用 ref 维护，避免 useEffect 闭包陷阱
 *  - 每条 assistant 消息可携带工具调用数组（toolRuns），便于卡片渲染
 *  - 多轮迭代场景下 onChunk 会持续累计 content，由 hook 自行去重最后一条 assistant
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
  AgentMessage,
  AgentSession,
  AgentSessionMeta,
  AgentChunkPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentToolStartPayload,
  AgentToolExecutingPayload,
  AgentToolExecutedPayload,
} from '@shared/types'

const DESKTOP_API_UNAVAILABLE_MESSAGE = '当前页面未连接桌面端能力，请在小小牛马桌面应用窗口中使用 Agent。'

const unavailableApi: typeof window.electronAPI = {
  invoke: async () => {
    throw new Error(DESKTOP_API_UNAVAILABLE_MESSAGE)
  },
  send: () => {},
  sendRaw: () => {},
  on: () => () => {},
}

const api = window.electronAPI ?? unavailableApi

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** 工具调用 UI 状态 */
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

/** 渲染端的扩展消息：assistant 携带 toolRuns 数组 + 当前迭代轮次 */
export interface UIAgentMessage extends AgentMessage {
  /** 仅 assistant 消息：本轮被发起的工具调用 + 状态 */
  toolRuns?: ToolRunUI[]
  /** 仅 assistant 消息：标识是否还在流式生成中 */
  streaming?: boolean
  /** 仅 assistant 消息：第几轮迭代 */
  iteration?: number
}

export interface UseAgentResult {
  /** 当前会话 id（不变，用于会话切换） */
  sessionId: string
  /** 渲染用消息列表 */
  messages: UIAgentMessage[]
  /** Agent 是否正在执行 */
  running: boolean
  /** 是否有未读完的错误（仅 fatal） */
  fatalError: string | null
  /** 当前正在执行的工具名（顶部状态栏用） */
  currentTool: string | null
  /** 发送新任务 */
  sendTask: (input: string) => Promise<void>
  /** 中止当前任务 */
  stopTask: () => Promise<void>
  /** 切换到新会话（生成新的 sessionId） */
  newSession: () => void
  /** 加载历史会话 */
  loadSession: (id: string) => Promise<void>
}

function genSessionId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export function useAgent(): UseAgentResult {
  const [sessionId, setSessionId] = useState<string>(() => genSessionId())
  const [messages, setMessages] = useState<UIAgentMessage[]>([])
  const [running, setRunning] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [currentTool, setCurrentTool] = useState<string | null>(null)

  // ref 跟踪当前 sessionId，事件回调里读最新值
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  /**
   * 在 messages 末尾找到/插入一条流式中的 assistant
   * 关键：每一轮迭代会有一条独立的 assistant；本轮内的 chunk 都更新最后一条
   */
  const upsertStreamingAssistant = useCallback((iteration: number, content: string, reasoning: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && last.iteration === iteration && last.streaming) {
        // 同一轮内的增量：覆盖
        const updated = { ...last, content, reasoning }
        return [...prev.slice(0, -1), updated]
      }
      // 新一轮：插入新的 assistant 占位
      const next: UIAgentMessage = {
        id: `asst_${iteration}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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

  /** 把工具调用列表挂到当前 streaming assistant 上 */
  const attachToolRuns = useCallback((iteration: number, toolCalls: AgentToolStartPayload['toolCalls']) => {
    const newRuns: ToolRunUI[] = toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      description: tc.description,
      safetyLevel: tc.safetyLevel,
      arguments: tc.arguments,
      status: 'pending',
    }))

    setMessages(prev => {
      // 找最后一条匹配 iteration 的 assistant
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]
        if (m.role === 'assistant' && m.iteration === iteration) {
          const updated = { ...m, toolRuns: [...(m.toolRuns ?? []), ...newRuns] }
          return [...prev.slice(0, i), updated, ...prev.slice(i + 1)]
        }
      }
      return prev
    })
  }, [])

  /** 更新某个工具的执行状态 */
  const updateToolRun = useCallback((toolId: string, patch: Partial<ToolRunUI>) => {
    setMessages(prev => {
      // 从后往前找首个包含该 toolId 的 assistant
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i]
        if (m.role !== 'assistant' || !m.toolRuns) continue
        const idx = m.toolRuns.findIndex(t => t.id === toolId)
        if (idx === -1) continue
        const updatedRuns = [...m.toolRuns]
        updatedRuns[idx] = { ...updatedRuns[idx], ...patch }
        const updated = { ...m, toolRuns: updatedRuns }
        return [...prev.slice(0, i), updated, ...prev.slice(i + 1)]
      }
      return prev
    })
  }, [])

  /** 发送新任务 */
  const sendTask = useCallback(async (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return
    if (running) return  // UI 层保护：执行中禁止再次提交

    const id = sessionIdRef.current

    // 把 user 消息立即加入列表
    setMessages(prev => [
      ...prev,
      {
        id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'user' as const,
        content: trimmed,
        createdAt: Date.now(),
      },
    ])
    setRunning(true)
    setFatalError(null)
    setCurrentTool(null)

    try {
      const result = await api.invoke(IPC.AGENT_START, {
        sessionId: id,
        userInput: trimmed,
      }) as { ok: boolean; sessionId?: string; error?: string }

      if (!result?.ok) {
        setRunning(false)
        setFatalError(result?.error ?? '启动失败')
      }
    } catch (error) {
      setRunning(false)
      setFatalError(getErrorMessage(error, '启动失败'))
    }
  }, [running])

  /** 中止当前任务 */
  const stopTask = useCallback(async () => {
    try {
      await api.invoke(IPC.AGENT_STOP, { sessionId: sessionIdRef.current })
    } catch {
      /* 桌面桥不可用或任务已结束时无需额外处理 */
    }
  }, [])

  /** 新开会话：清空消息并生成新 id */
  const newSession = useCallback(() => {
    if (running) return
    const id = genSessionId()
    setSessionId(id)
    setMessages([])
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  /** 加载历史会话（把消息转成 UI 形态） */
  const loadSession = useCallback(async (id: string) => {
    if (running) return
    let session: AgentSession | null = null
    try {
      session = await api.invoke(IPC.AGENT_GET_SESSION, id) as AgentSession | null
    } catch (error) {
      setFatalError(getErrorMessage(error, '加载历史会话失败'))
      return
    }
    if (!session) return

    setSessionId(id)
    // 历史消息直接投影；工具调用从 tool 角色消息回填到 assistant 的 toolRuns
    const ui = projectHistoryToUI(session.messages)
    setMessages(ui)
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  // ── IPC 事件订阅 ─────────────────────────────
  useEffect(() => {
    const filter = (sid: string) => sid === sessionIdRef.current

    const offChunk = api.on(IPC.AGENT_CHUNK, ((p: AgentChunkPayload) => {
      if (!filter(p.sessionId)) return
      upsertStreamingAssistant(p.iteration, p.content, p.reasoning)
    }) as (...args: unknown[]) => void)

    const offToolStart = api.on(IPC.AGENT_TOOL_START, ((p: AgentToolStartPayload) => {
      if (!filter(p.sessionId)) return
      attachToolRuns(p.iteration, p.toolCalls)
    }) as (...args: unknown[]) => void)

    const offToolExecuting = api.on(IPC.AGENT_TOOL_EXECUTING, ((p: AgentToolExecutingPayload) => {
      if (!filter(p.sessionId)) return
      setCurrentTool(p.toolName)
      updateToolRun(p.toolId, { status: 'running' })
    }) as (...args: unknown[]) => void)

    const offToolExecuted = api.on(IPC.AGENT_TOOL_EXECUTED, ((p: AgentToolExecutedPayload) => {
      if (!filter(p.sessionId)) return
      setCurrentTool(null)
      updateToolRun(p.toolId, {
        status: p.success ? 'success' : 'error',
        output: p.output,
        error: p.error,
        durationMs: p.durationMs,
      })
    }) as (...args: unknown[]) => void)

    const offDone = api.on(IPC.AGENT_DONE, ((p: AgentDonePayload) => {
      if (!filter(p.sessionId)) return
      setRunning(false)
      setCurrentTool(null)
      // 把最后一条 streaming assistant 标记为完成
      setMessages(prev => prev.map((m, idx) => {
        if (idx === prev.length - 1 && m.role === 'assistant' && m.streaming) {
          return { ...m, streaming: false, content: p.content || m.content }
        }
        return m
      }))
    }) as (...args: unknown[]) => void)

    const offError = api.on(IPC.AGENT_ERROR, ((p: AgentErrorPayload) => {
      if (!filter(p.sessionId)) return
      if (p.fatal) {
        setRunning(false)
        setCurrentTool(null)
        setFatalError(p.error)
      }
    }) as (...args: unknown[]) => void)

    return () => {
      offChunk(); offToolStart(); offToolExecuting(); offToolExecuted(); offDone(); offError()
    }
  }, [upsertStreamingAssistant, attachToolRuns, updateToolRun])

  return {
    sessionId,
    messages,
    running,
    fatalError,
    currentTool,
    sendTask,
    stopTask,
    newSession,
    loadSession,
  }
}

/**
 * 把存储里的扁平消息列表（含 role=tool）投影成 UI 消息：
 * 每条 assistant 自带 toolRuns（已完成状态），role=tool 消息被吸收掉
 */
function projectHistoryToUI(messages: AgentMessage[]): UIAgentMessage[] {
  const ui: UIAgentMessage[] = []
  // toolCallId → 输出 / 错误
  const toolResultMap = new Map<string, { output?: string; error?: string }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.tool_call_id) {
      const isErr = m.content.startsWith('[ERROR]')
      toolResultMap.set(m.tool_call_id, isErr ? { error: m.content.slice(7).trim() } : { output: m.content })
    }
  }

  for (const m of messages) {
    if (m.role === 'tool') continue  // tool 消息不直接渲染
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const toolRuns: ToolRunUI[] = m.tool_calls.map(tc => {
        let parsedArgs: Record<string, unknown> = {}
        try { parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown> } catch { /* ignore */ }
        const result = toolResultMap.get(tc.id)
        return {
          id: tc.id,
          name: tc.name,
          description: '',
          safetyLevel: inferToolSafety(tc.name),
          arguments: parsedArgs,
          status: result?.error ? 'error' : 'success',
          output: result?.output,
          error: result?.error,
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

/** 列出会话元数据（暴露给会话切换 UI） */
export async function listAgentSessions(): Promise<AgentSessionMeta[]> {
  try {
    return (await api.invoke(IPC.AGENT_LIST_SESSIONS)) as AgentSessionMeta[]
  } catch {
    return []
  }
}

/** 删除会话 */
export async function deleteAgentSession(id: string): Promise<boolean> {
  try {
    const r = await api.invoke(IPC.AGENT_DELETE_SESSION, id) as { ok: boolean }
    return Boolean(r?.ok)
  } catch {
    return false
  }
}

/** 重命名会话 */
export async function renameAgentSession(id: string, title: string): Promise<boolean> {
  try {
    const r = await api.invoke(IPC.AGENT_RENAME_SESSION, { id, title }) as { ok: boolean }
    return Boolean(r?.ok)
  } catch {
    return false
  }
}
