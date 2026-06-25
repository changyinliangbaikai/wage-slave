// ─────────────────────────────────────────────
// 统一对话系统类型（AI 对话 + Agent 模式合并）
//
// 设计目标（见 plan/merge-ai-chat-and-agent-chat.md）：
//   把「AI 快速对话」与「Agent 工具模式」收敛到同一套消息 / 会话 / IPC 模型，
//   由 ChatSession.config.mode 区分执行策略：
//     - 'chat'  → 单轮流式对话（复用 ai-chat-service）
//     - 'agent' → 多轮迭代 + 工具调用（复用 agent/orchestrator）
//
// 为了与现存的 AIChatMessage / AgentMessage 平滑互转，ChatMessage 被设计为
// 两者的「超集」：同时携带简单对话的 stats 与 Agent 的 tool_calls / tool 字段。
// ─────────────────────────────────────────────

import type { AIChatStats, AIChatAttachment } from './types'

/** 对话模式：简单对话 / Agent 工具模式 */
export type ChatMode = 'chat' | 'agent'

/** 统一的消息角色 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** assistant 发起的原始工具调用（OpenAI 兼容，arguments 为 JSON 字符串） */
export interface ChatToolCallRaw {
  id: string
  name: string
  /** JSON 字符串形式参数 */
  arguments: string
}

/**
 * 统一消息类型（兼容简单对话与 Agent 工具）
 *
 * 字段分组：
 *   - 通用：id / role / content / reasoning / createdAt
 *   - Agent：tool_calls（assistant 发起）/ tool_call_id / tool_name（tool 角色结果）
 *   - 简单对话：stats（assistant 的 token 统计）
 *   - metadata：模型 / 迭代轮次等附加信息
 */
export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  /** 推理过程（<think> 或 reasoning_content） */
  reasoning?: string
  /** assistant 本轮发起的工具调用（Agent 模式） */
  tool_calls?: ChatToolCallRaw[]
  /** tool 角色：对应的工具调用 id */
  tool_call_id?: string
  /** tool 角色：工具名称（便于 UI 渲染） */
  tool_name?: string
  /** assistant 的 token 统计（简单对话模式） */
  stats?: AIChatStats
  /** 附件列表 */
  attachments?: AIChatAttachment[]
  /** 附加元信息 */
  metadata?: {
    model?: string
    /** Agent 第几轮迭代 */
    iteration?: number
    /** 本轮提示词 token 数（来自 OpenAI usage.prompt_tokens） */
    promptTokens?: number
    /** 本轮补全 token 数（usage.completion_tokens） */
    completionTokens?: number
    /** 本轮合计 token（usage.total_tokens） */
    totalTokens?: number
    /** 模型上下文窗口上限（用于前端计算占比；缺省 32768） */
    maxTokens?: number
  }
  createdAt: number
}

/** 会话配置（区分模式 + 模型等） */
export interface ChatSessionConfig {
  /** 关键：区分简单对话与 Agent 模式 */
  mode: ChatMode
  /** 使用的模型名（缺省时跟随全局配置） */
  model?: string
  temperature?: number
  /** Agent 最大迭代步数 */
  maxIterations?: number
  systemPrompt?: string
  /** 简单对话使用的预置角色 id */
  personaId?: string
}

/** 会话统计 */
export interface ChatSessionStats {
  totalTokens: number
  totalToolCalls: number
  totalIterations: number
  totalDurationMs: number
}

/** 会话元数据（列表用，不含完整消息） */
export interface ChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 首条用户消息预览 */
  preview: string
  /** 会话模式（来源于 config.mode，列表用） */
  mode: ChatMode
  /** 归属项目 id；缺省按 'default' 处理（用于多项目过滤） */
  projectId?: string
}

/** 完整会话（元数据 + 消息 + 配置 + 统计） */
export interface ChatSession extends ChatSessionMeta {
  messages: ChatMessage[]
  config: ChatSessionConfig
  stats?: ChatSessionStats
  /** 归属项目 id（在 Meta 基础上同步存储到完整会话，便于按项目过滤） */
  projectId?: string
}

/** 搜索命中结果 */
export interface ChatSearchHit {
  sessionId: string
  title: string
  updatedAt: number
  mode: ChatMode
  snippet: string
  matchCount: number
  matchedMessageIds: string[]
}

// ─────────────────────────────────────────────
// 统一对话 IPC 载荷（main ↔ renderer）
// ─────────────────────────────────────────────

/** 发起对话请求参数（renderer → main） */
export interface ChatStartParams {
  sessionId: string
  mode: ChatMode
  userInput: string
  /** 附件列表 */
  attachments?: AIChatAttachment[]
  /** 简单对话模式：本轮 assistant 占位消息 id，用于流式定位 */
  assistantMessageId?: string
  /** 简单对话模式：之前的历史（包含 role、content、attachments） */
  history?: Array<Pick<ChatMessage, 'role' | 'content' | 'attachments'>>
  /** 简单对话模式：预置角色注入的 system prompt */
  systemPrompt?: string
  /** Agent 模式：覆盖最大迭代轮次 */
  maxIterations?: number
  /** 当前会话归属的项目 id；缺省为 'default' */
  projectId?: string
}

/** 流式文本/思考增量（main → renderer） */
export interface ChatChunkPayload {
  sessionId: string
  /** 简单对话模式：对应的 assistant 消息 id */
  messageId?: string
  content: string
  reasoning: string
  /** Agent 模式：当前迭代轮次 */
  iteration?: number
}

/** Token 使用量元信息（用于 UI 显示上下文占比） */
export interface ChatTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** 模型上下文窗口上限（推断或来自配置） */
  maxTokens: number
  /** 当前迭代轮次（Agent 模式） */
  iteration?: number
}

/** 工具事件阶段 */
export type ChatToolPhase = 'start' | 'executing' | 'executed'

/** 工具调用事件（main → renderer，仅 Agent 模式） */
export interface ChatToolEventPayload {
  sessionId: string
  phase: ChatToolPhase
  iteration?: number
  /** phase=start：本轮要执行的工具列表 */
  toolCalls?: Array<{
    id: string
    name: string
    description: string
    safetyLevel: 'safe' | 'cautious' | 'sensitive'
    arguments: Record<string, unknown>
  }>
  /** phase=start：本轮 LLM 调用的 token 使用情况，便于前端实时显示上下文占比 */
  tokenUsage?: ChatTokenUsage
  /** phase=executing/executed：单个工具 */
  toolId?: string
  toolName?: string
  /** phase=executed */
  success?: boolean
  output?: string
  error?: string
  durationMs?: number
}

/** 完成载荷（main → renderer） */
export interface ChatDonePayload {
  sessionId: string
  /** 简单对话模式：assistant 消息 id */
  messageId?: string
  content: string
  reasoning?: string
  /** 简单对话模式 token 统计 */
  stats?: AIChatStats
  /** Agent 模式累计统计 */
  agentStats?: {
    iterations: number
    toolCalls: number
    totalDurationMs: number
  }
  /** 最终一轮的 token 使用情况（Agent 模式：最后一轮 LLM 输出） */
  tokenUsage?: ChatTokenUsage
  /** 是否被用户/超时中断 */
  aborted?: boolean
}

/** 错误载荷（main → renderer） */
export interface ChatErrorPayload {
  sessionId: string
  messageId?: string
  error: string
  /** true 表示无法恢复，前端应停止流 */
  fatal?: boolean
}

/** CHAT_START 调用返回 */
export interface ChatStartResult {
  ok: boolean
  sessionId?: string
  error?: string
}
