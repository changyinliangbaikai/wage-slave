/**
 * 统一对话存储层（facade）
 *
 * 不做破坏性数据迁移：底层仍复用既有的两套存储
 *   - 简单对话：ai-chat-store.ts          → {userData}/ai-chats/*.json
 *   - Agent：  agent/session-store.ts     → {userData}/agent-sessions/*.json
 *
 * 本模块把两者「读时合并」为统一的 ChatSession 视图，并按 mode 路由写入，
 * 从而实现「历史互通、统一搜索」而不丢失任何既有数据。
 *
 * 会话路由约定（依据 id 前缀，写入/读取均一致）：
 *   - id 以 'agent_' 开头        → Agent 存储
 *   - 其它（含 'chat_' / 旧 id） → 简单对话存储
 */

import type {
  AIChatMessage,
  AIChatSession,
  AgentMessage,
  AgentSession,
} from '@shared/types'
import type {
  ChatMessage,
  ChatSession,
  ChatSessionMeta,
  ChatSearchHit,
  ChatMode,
} from '@shared/types-chat'

import * as aiStore from '../ai-chat-store'
import * as agentStore from '../agent/session-store'

/** 判断会话 id 属于哪种模式（路由依据） */
export function modeOfId(id: string): ChatMode {
  return id.startsWith('agent_') ? 'agent' : 'chat'
}

/** 生成新会话 id（带模式前缀，保证路由一致） */
export function genChatSessionId(mode: ChatMode): string {
  const rand = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return mode === 'agent' ? `agent_${rand}` : `chat_${rand}`
}

// ── 转换：legacy → 统一 ─────────────────────────

function aiMsgToChat(m: AIChatMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    stats: m.stats,
    createdAt: m.createdAt,
  }
}

function agentMsgToChat(m: AgentMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    tool_name: m.tool_name,
    createdAt: m.createdAt,
  }
}

function aiSessionToChat(s: AIChatSession): ChatSession {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    preview: s.preview,
    mode: 'chat',
    messages: (s.messages ?? []).map(aiMsgToChat),
    config: { mode: 'chat', personaId: s.personaId },
  }
}

function agentSessionToChat(s: AgentSession): ChatSession {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    preview: s.preview,
    mode: 'agent',
    messages: (s.messages ?? []).map(agentMsgToChat),
    config: { mode: 'agent' },
    stats: s.stats
      ? {
          totalTokens: 0,
          totalToolCalls: s.stats.toolCalls,
          totalIterations: s.stats.iterations,
          totalDurationMs: s.stats.totalDurationMs,
        }
      : undefined,
  }
}

// ── 转换：统一 → legacy（保存时使用） ──────────

function chatMsgToAi(m: ChatMessage): AIChatMessage {
  return {
    id: m.id,
    role: m.role === 'tool' ? 'assistant' : m.role,
    content: m.content,
    reasoning: m.reasoning,
    stats: m.stats,
    createdAt: m.createdAt,
  }
}

function chatMsgToAgent(m: ChatMessage): AgentMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    tool_name: m.tool_name,
    createdAt: m.createdAt,
  }
}

// ── 公共 API ────────────────────────────────────

/** 列出全部会话（合并两套存储，按 updatedAt 倒序） */
export function listSessions(): ChatSessionMeta[] {
  const chat: ChatSessionMeta[] = aiStore.listSessions().map(m => ({ ...m, mode: 'chat' as const }))
  const agent: ChatSessionMeta[] = agentStore.listAgentSessions().map(m => ({ ...m, mode: 'agent' as const }))
  return [...chat, ...agent].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取一条完整会话（按 id 前缀路由） */
export function getSession(id: string): ChatSession | null {
  if (modeOfId(id) === 'agent') {
    const s = agentStore.getAgentSession(id)
    return s ? agentSessionToChat(s) : null
  }
  const s = aiStore.getSession(id)
  return s ? aiSessionToChat(s) : null
}

/** 保存/更新一条会话（按 config.mode 路由） */
export function saveSession(session: ChatSession): ChatSessionMeta {
  if (session.config.mode === 'agent') {
    const agentSession: AgentSession = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
      preview: session.preview,
      messages: session.messages.map(chatMsgToAgent),
      stats: {
        iterations: session.stats?.totalIterations ?? 0,
        toolCalls: session.stats?.totalToolCalls ?? 0,
        totalDurationMs: session.stats?.totalDurationMs ?? 0,
      },
    }
    const meta = agentStore.saveAgentSession(agentSession)
    return { ...meta, mode: 'agent' }
  }

  const aiSession: AIChatSession = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    preview: session.preview,
    messages: session.messages.map(chatMsgToAi),
    personaId: session.config.personaId,
  }
  const meta = aiStore.saveSession(aiSession)
  return { ...meta, mode: 'chat' }
}

/** 删除一条会话（按 id 前缀路由） */
export function deleteSession(id: string): boolean {
  return modeOfId(id) === 'agent'
    ? agentStore.deleteAgentSession(id)
    : aiStore.deleteSession(id)
}

/** 重命名会话（按 id 前缀路由） */
export function renameSession(id: string, title: string): boolean {
  return modeOfId(id) === 'agent'
    ? agentStore.renameAgentSession(id, title)
    : aiStore.renameSession(id, title)
}

/** 全文搜索（合并两套存储） */
export function searchSessions(query: string): ChatSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  // 简单对话：复用现成的搜索实现
  const chatHits: ChatSearchHit[] = aiStore.searchSessions(query).map(h => ({
    sessionId: h.sessionId,
    title: h.title,
    updatedAt: h.updatedAt,
    mode: 'chat' as const,
    snippet: h.snippet,
    matchCount: h.matchCount,
    matchedMessageIds: h.matchedMessageIds,
  }))

  // Agent：在合并视图上做一次轻量子串搜索
  const agentHits: ChatSearchHit[] = []
  for (const meta of agentStore.listAgentSessions()) {
    const s = agentStore.getAgentSession(meta.id)
    if (!s) continue
    let matchCount = 0
    let snippet = ''
    const matchedMessageIds: string[] = []
    if (s.title.toLowerCase().includes(q)) matchCount++
    for (const m of s.messages ?? []) {
      const lower = (m.content ?? '').toLowerCase()
      const idx = lower.indexOf(q)
      if (idx === -1) continue
      matchCount++
      matchedMessageIds.push(m.id)
      if (!snippet) {
        const start = Math.max(0, idx - 20)
        snippet = (start > 0 ? '…' : '') + m.content.slice(start, idx + q.length + 40)
      }
    }
    if (matchCount > 0) {
      agentHits.push({
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        mode: 'agent',
        snippet,
        matchCount,
        matchedMessageIds,
      })
    }
  }

  return [...chatHits, ...agentHits].sort((a, b) => b.updatedAt - a.updatedAt)
}
