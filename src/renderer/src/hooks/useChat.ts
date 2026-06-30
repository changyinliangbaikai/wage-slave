/**
 * 统一对话状态管理 Hook（仅支持 Agent 模式）
 *
 * 历史背景：之前同时支持「快速对话 / Agent」双模式，后改为只保留 Agent 模式，
 * 所有会话默认带工具调用 + 多轮规划能力（见 plan/next-steps-optimization.md §1）。
 *
 * - 会话 id 一律使用 'agent_' 前缀；
 * - 流式状态由 `upsertStreamingAssistant` 维护，按 iteration 区分 assistant 消息；
 * - 主进程在每轮迭代后自动 saveAgentSession 持久化，渲染端无需干预。
 *
 * 与主进程通过统一的 CHAT_* 通道通信：
 *   CHAT_START / CHAT_STOP / CHAT_CHUNK / CHAT_TOOL_EVENT / CHAT_DONE / CHAT_ERROR
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC } from '@shared/ipc-channels'
import type {
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
import type { AIChatAttachment } from '@shared/types'
import type { Project } from '@shared/types-project'

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

/** 生成 Agent 模式会话 id（与主进程 chat-store 路由约定一致） */
function genSessionId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
  /** Agent 第几轮迭代 */
  iteration?: number
}

export interface UseChatResult {
  sessionId: string
  projectId: string
  messages: UIChatMessage[]
  running: boolean
  fatalError: string | null
  currentTool: string | null
  sendMessage: (content: string, attachments?: AIChatAttachment[]) => Promise<void>
  stopGeneration: () => Promise<void>
  newSession: () => void
  loadSession: (id: string) => Promise<void>
  switchProject: (projectId: string) => void
  /** 重新生成最后一条 assistant 回复：移除最后的 assistant 消息，重发上一条 user 消息 */
  regenerate: () => Promise<void>
  /**
   * 解析 Slash 命令；
   * 返回 { handled: true, transformedInput? } 表示已处理：
   *   - transformedInput 存在 → 用它替换原始输入发给 LLM（模板插入型）
   *   - transformedInput 不存在 → 命令已就地完成（状态控制型），调用方不应再发送
   * 返回 { handled: false } 表示未识别为命令，调用方应按普通消息处理。
   */
  runSlashCommand: (input: string) => Promise<{ handled: boolean; transformedInput?: string }>
}

export function useChat(): UseChatResult {
  const [sessionId, setSessionId] = useState<string>(() => genSessionId())
  const [projectId, setProjectId] = useState<string>('default')
  const [messages, setMessages] = useState<UIChatMessage[]>([])
  const [running, setRunning] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [currentTool, setCurrentTool] = useState<string | null>(null)

  // 事件回调里读最新值，避免闭包陷阱
  const sessionIdRef = useRef(sessionId)
  const projectIdRef = useRef(projectId)
  const messagesRef = useRef(messages)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { projectIdRef.current = projectId }, [projectId])
  useEffect(() => { messagesRef.current = messages }, [messages])

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

  // ── 发送消息 ──────────────────────────────────
  const sendMessage = useCallback(async (content: string, attachments?: AIChatAttachment[]) => {
    const trimmed = content.trim()
    if ((!trimmed && (!attachments || attachments.length === 0)) || running) return

    const id = sessionIdRef.current
    const userMsg: UIChatMessage = {
      id: genId('user'), role: 'user', content: trimmed, attachments, createdAt: Date.now(),
    }

    setRunning(true)
    setFatalError(null)
    setCurrentTool(null)
    // Agent 模式由主进程在每轮迭代后推送 chunk 时动态插入 assistant
    setMessages(prev => [...prev, userMsg])

    const params: ChatStartParams = {
      sessionId: id,
      mode: 'agent',
      userInput: trimmed,
      attachments,
      // 把当前选中的项目透传到主进程，决定 Agent 的工作目录与白名单
      projectId: projectIdRef.current,
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

  const newSession = useCallback(() => {
    if (running) return
    setSessionId(genSessionId())
    setMessages([])
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

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
    setSessionId(id)
    // 加载历史时自动切换到会话归属的项目
    if (session.projectId) setProjectId(session.projectId)
    setMessages(projectMessagesToUI(session.messages))
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  /** 切换项目：清空当前会话状态，新建一个属于目标项目的会话 */
  const switchProject = useCallback((next: string) => {
    if (running || !next || next === projectIdRef.current) return
    setProjectId(next)
    setSessionId(genSessionId())
    setMessages([])
    setFatalError(null)
    setCurrentTool(null)
  }, [running])

  /** 在消息流中插入一条"系统提示"气泡（仅前端展示，不进入会话历史发送给 LLM） */
  const appendSystemMessage = useCallback((content: string) => {
    const msg: UIChatMessage = {
      id: genId('sys'),
      role: 'assistant',
      content,
      createdAt: Date.now(),
      // 用一个独特 iteration（-1）标识"非真实 LLM 输出"，避免与流式状态冲突
      iteration: -1,
      streaming: false,
    }
    setMessages(prev => [...prev, msg])
  }, [])

  /** 重新生成：移除最后一条 assistant 回复，用上一条 user 消息重新发送 */
  const regenerate = useCallback(async () => {
    if (running) return
    // 从尾部找到最后一条 user 消息及其后的 assistant 回复
    let lastUserIdx = -1
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      if (messagesRef.current[i].role === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return
    const userMsg = messagesRef.current[lastUserIdx]
    // 截断到 user 消息之前（移除该 user 消息及其后所有 assistant 回复）
    setMessages(prev => prev.slice(0, lastUserIdx))
    // 重新发送同一条 user 消息
    await sendMessage(userMsg.content, userMsg.attachments)
  }, [running, sendMessage])

  /** 解析并执行 Slash 命令 */
  const runSlashCommand = useCallback(async (raw: string): Promise<{ handled: boolean; transformedInput?: string }> => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/')) return { handled: false }

    // 解析 "/cmd arg1 arg2..."
    const space = trimmed.indexOf(' ')
    const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    const arg = space === -1 ? '' : trimmed.slice(space + 1).trim()

    switch (cmd) {
      case '/help': {
        appendSystemMessage(buildHelpText())
        return { handled: true }
      }

      case '/plan': {
        // 模板插入型：把"先在 plan/proposal.md 中写下你的计划"的指令前置注入
        const planPrompt = `[计划模式]
进入计划模式：本次任务请先在当前项目的工作目录下创建或更新 plan/proposal.md，写下你的实施步骤、关键改动点与潜在风险。
- 在用户明确批准 plan/proposal.md 之前，**禁止**对源码或配置文件进行任何写入、编辑、删除操作。
- 你可以使用 read_file、grep_code、glob_files、list_files 等只读工具收集信息。
- 完成 proposal 后输出一段简短摘要并询问用户是否同意按此计划执行。

用户原始任务：
${arg || '(空)'}`
        return { handled: true, transformedInput: planPrompt }
      }

      case '/model': {
        if (!arg) {
          const cfg = await getAppConfig()
          // 应用已合并为单一模型配置：优先读全局 llm_model；保留 agent_llm_model 兼容历史 config
          const cur = (cfg.llm_model as string) || (cfg.agent_llm_model as string) || '(未配置)'
          appendSystemMessage(`当前模型：\`${cur}\`\n\n用法：\`/model <模型名>\` 切换当前使用的模型`)
        } else {
          // 写入全局 llm_model，所有模块都跟随生效
          const ok = await setAppConfig({ llm_model: arg })
          appendSystemMessage(ok ? `已切换模型为：\`${arg}\`` : '切换模型失败')
        }
        return { handled: true }
      }

      case '/effort': {
        const lvl = arg.toLowerCase()
        if (!arg) {
          const cfg = await getAppConfig()
          appendSystemMessage(`当前推理强度：\`${(cfg.agent_reasoning_effort as string) || '默认'}\`\n\n用法：\`/effort low | medium | high\``)
          return { handled: true }
        }
        if (lvl !== 'low' && lvl !== 'medium' && lvl !== 'high') {
          appendSystemMessage('推理强度只能是 low / medium / high')
          return { handled: true }
        }
        const ok = await setAppConfig({ agent_reasoning_effort: lvl })
        appendSystemMessage(ok ? `已设置推理强度为：\`${lvl}\`（仅对支持 reasoning 的模型生效）` : '设置失败')
        return { handled: true }
      }

      case '/compact': {
        appendSystemMessage('⏳ 正在压缩会话历史...')
        const res = await compactSession(sessionIdRef.current)
        if (!res.ok) {
          appendSystemMessage(`❌ /compact 失败：${res.error}`)
          return { handled: true }
        }
        // 压缩成功后重载会话，确保前端拿到最新的折叠后历史
        try {
          const session = (await api.invoke(IPC.CHAT_GET_SESSION, sessionIdRef.current)) as ChatSession | null
          if (session) setMessages(projectMessagesToUI(session.messages))
        } catch { /* ignore */ }
        appendSystemMessage(`✅ 已永久压缩 ${res.removed ?? 0} 条历史为摘要：\n\n${res.summary ?? ''}`)
        return { handled: true }
      }

      default: {
        appendSystemMessage(`未识别的命令：\`${cmd}\`\n输入 \`/help\` 查看所有可用命令`)
        return { handled: true }
      }
    }
  }, [appendSystemMessage])

  // ── IPC 事件订阅 ─────────────────────────────
  useEffect(() => {
    const mine = (sid: string) => sid === sessionIdRef.current

    const offChunk = api.on(IPC.CHAT_CHUNK, ((p: ChatChunkPayload) => {
      if (!mine(p.sessionId)) return
      if (typeof p.iteration === 'number') {
        upsertStreamingAssistant(p.iteration, p.content, p.reasoning)
      }
    }) as (...a: unknown[]) => void)

    const offTool = api.on(IPC.CHAT_TOOL_EVENT, ((p: ChatToolEventPayload) => {
      if (!mine(p.sessionId)) return
      if (p.phase === 'start' && typeof p.iteration === 'number' && p.toolCalls) {
        // 截断 Bug 修复：进入工具执行阶段时，立刻把上一轮 streaming 状态关闭，
        // 同时把本轮 LLM 的 tokenUsage 写入对应 assistant 的 metadata（用于上下文进度条）
        const iter = p.iteration
        const tu = p.tokenUsage
        setMessages(prev => prev.map(m => {
          if (m.role !== 'assistant' || m.iteration !== iter) return m
          const next: UIChatMessage = { ...m, streaming: false }
          if (tu) {
            next.metadata = {
              ...(m.metadata ?? {}),
              iteration: iter,
              promptTokens: tu.promptTokens,
              completionTokens: tu.completionTokens,
              totalTokens: tu.totalTokens,
              maxTokens: tu.maxTokens,
            }
          }
          return next
        }))
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
      setMessages(prev => prev.map((m, idx) => {
        // 收尾最后一条 streaming assistant；把最终的 tokenUsage 合并入 metadata
        const isTarget = idx === prev.length - 1 && m.role === 'assistant' && m.streaming
        if (!isTarget) return m
        const tu = p.tokenUsage
        const mergedMeta = tu
          ? {
              ...(m.metadata ?? {}),
              iteration: tu.iteration ?? m.metadata?.iteration,
              promptTokens: tu.promptTokens,
              completionTokens: tu.completionTokens,
              totalTokens: tu.totalTokens,
              maxTokens: tu.maxTokens,
            }
          : m.metadata
        return { ...m, streaming: false, content: p.content || m.content, reasoning: p.reasoning ?? m.reasoning, metadata: mergedMeta }
      }))
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
  }, [upsertStreamingAssistant, attachToolRuns, updateToolRun])

  return {
    sessionId, projectId, messages, running, fatalError, currentTool,
    sendMessage, stopGeneration, newSession, loadSession, switchProject,
    runSlashCommand, regenerate,
  }
}

/** 命令帮助文本 */
function buildHelpText(): string {
  return `### 🐱 小小牛马 Slash 命令

| 命令 | 说明 |
| --- | --- |
| \`/help\` | 显示本帮助 |
| \`/plan <任务描述>\` | 进入计划模式：要求 Agent 先把方案写入 \`plan/proposal.md\`，未经批准前禁止改代码 |
| \`/model [模型名]\` | 查看或切换 Agent 使用的模型（不带参数则只读当前模型） |
| \`/effort low\|medium\|high\` | 设置 reasoning 推理强度（仅支持 reasoning 的模型生效） |
| \`/compact\` | 永久压缩当前会话历史：保留首条 user + 最近 4 条，其余压成一段摘要 |

> 命令在前端拦截执行；状态控制型命令不会发送给 LLM。`
}

// ─────────────────────────────────────────────
// 项目管理：暴露给页面的简洁封装
// ─────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  try {
    return (await api.invoke(IPC.PROJECT_LIST)) as Project[]
  } catch {
    return []
  }
}

export async function createProject(input: { name: string; path?: string; createDir?: boolean }): Promise<{ ok: boolean; project?: Project; error?: string }> {
  try {
    return (await api.invoke(IPC.PROJECT_CREATE, input)) as { ok: boolean; project?: Project; error?: string }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '创建项目失败' }
  }
}

export async function renameProject(id: string, name: string): Promise<boolean> {
  try {
    const res = (await api.invoke(IPC.PROJECT_RENAME, { id, name })) as { ok: boolean }
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

export async function deleteProject(id: string): Promise<boolean> {
  try {
    const res = (await api.invoke(IPC.PROJECT_DELETE, id)) as { ok: boolean }
    return Boolean(res?.ok)
  } catch {
    return false
  }
}

export async function pickProjectDir(): Promise<string | null> {
  try {
    const res = (await api.invoke(IPC.PROJECT_PICK_DIR)) as { ok: boolean; path?: string; canceled?: boolean }
    if (res?.ok && res.path) return res.path
    return null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────
// /compact 永久压缩当前会话
// ─────────────────────────────────────────────
export async function compactSession(sessionId: string): Promise<{ ok: boolean; error?: string; summary?: string; removed?: number }> {
  try {
    return (await api.invoke(IPC.CHAT_COMPACT_SESSION, sessionId)) as { ok: boolean; error?: string; summary?: string; removed?: number }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : '/compact 调用失败' }
  }
}

// ─────────────────────────────────────────────
// 通用配置读写（用于 /model、/effort）
// ─────────────────────────────────────────────
export async function getAppConfig(): Promise<Record<string, unknown>> {
  try {
    return (await api.invoke(IPC.CONFIG_GET)) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function setAppConfig(patch: Record<string, unknown>): Promise<boolean> {
  try {
    await api.invoke(IPC.CONFIG_SET, patch)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────
// 历史消息投影：把扁平存储消息转为带 toolRuns 的 UI 消息（始终按 Agent 模式渲染）
// ─────────────────────────────────────────────
function projectMessagesToUI(messages: ChatMessage[]): UIChatMessage[] {
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
/**
 * 列出会话；可按项目过滤（不传则返回全部）
 */
export async function listChatSessions(opts?: { projectId?: string }): Promise<ChatSessionMeta[]> {
  try {
    return (await api.invoke(IPC.CHAT_LIST_SESSIONS, opts)) as ChatSessionMeta[]
  } catch {
    return []
  }
}

export async function deleteChatSession(id: string): Promise<boolean> {
  try {
    const res = (await api.invoke(IPC.CHAT_DELETE_SESSION, id)) as { ok: boolean }
    return Boolean(res?.ok)
  } catch {
    return false
  }
}
