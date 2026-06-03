/**
 * Agent 会话持久化
 *
 * 存储结构（参考 ai-chat-store.ts，保持一致）：
 *   {userData}/agent-sessions/{sessionId}.json
 *
 * 不维护索引文件，列表/搜索直接扫目录；
 * 数千会话量级以下性能完全够用。
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import log from 'electron-log/main'
import type {
  AgentMessage,
  AgentSession,
  AgentSessionMeta,
} from '@shared/types'

const SESSIONS_DIR = path.join(app.getPath('userData'), 'agent-sessions')
ensureDir()

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

function atomicWrite(filePath: string, data: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, filePath)
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/** 会话文件路径（防止 id 路径穿越） */
function sessionFile(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(SESSIONS_DIR, `${safe}.json`)
}

function toMeta(s: AgentSession): AgentSessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messageCount,
    preview: s.preview,
  }
}

/**
 * 由消息列表派生标题与预览
 * 取首条 user 消息为标题，首条 user + 首条 assistant 拼成预览
 */
export function deriveSessionMeta(messages: AgentMessage[]): { title: string; preview: string } {
  const firstUser = messages.find(m => m.role === 'user')?.content?.trim() ?? ''
  const title = firstUser ? firstUser.slice(0, 24) : '新会话'
  const firstAssistant = messages.find(m => m.role === 'assistant')?.content?.trim() ?? ''
  const preview = (firstUser + (firstAssistant ? '  ·  ' + firstAssistant : ''))
    .replace(/\s+/g, ' ')
    .slice(0, 80)
  return { title, preview }
}

/** 列出所有会话元数据（按 updatedAt 倒序） */
export function listAgentSessions(): AgentSessionMeta[] {
  ensureDir()
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
  const metas: AgentSessionMeta[] = []
  for (const f of files) {
    const s = readJSON<AgentSession | null>(path.join(SESSIONS_DIR, f), null)
    if (!s || !s.id) continue
    metas.push(toMeta(s))
  }
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 读取一个完整会话 */
export function getAgentSession(id: string): AgentSession | null {
  return readJSON<AgentSession | null>(sessionFile(id), null)
}

/** 保存一条会话（自动派生 title/preview，并刷新 updatedAt） */
export function saveAgentSession(session: AgentSession): AgentSessionMeta {
  ensureDir()
  const now = Date.now()
  const derived = deriveSessionMeta(session.messages ?? [])

  const normalized: AgentSession = {
    ...session,
    title: session.title && session.title.trim() && session.title !== '新会话'
      ? session.title
      : derived.title,
    preview: derived.preview,
    messageCount: session.messages?.length ?? 0,
    createdAt: session.createdAt || now,
    updatedAt: now,
  }
  atomicWrite(sessionFile(normalized.id), normalized)
  return toMeta(normalized)
}

/** 删除一条会话 */
export function deleteAgentSession(id: string): boolean {
  const f = sessionFile(id)
  try {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      log.info(`[AgentSession] 删除 id=${id}`)
      return true
    }
  } catch (e) {
    log.error('[AgentSession] 删除失败:', e)
  }
  return false
}

/** 重命名会话标题 */
export function renameAgentSession(id: string, title: string): boolean {
  const s = getAgentSession(id)
  if (!s) return false
  s.title = title.trim().slice(0, 60) || s.title
  s.updatedAt = Date.now()
  atomicWrite(sessionFile(id), s)
  return true
}

/** 生成新会话 id */
export function genAgentSessionId(): string {
  return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
