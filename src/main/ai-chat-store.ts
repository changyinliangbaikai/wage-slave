/**
 * AI 对话持久化 & 搜索
 *
 * 存储结构：
 *  - {userData}/ai-chats/{sessionId}.json     每条会话一个文件
 *
 * 没有单独的索引文件，listSessions/search 直接扫描目录。
 * 这样可以避免索引同步问题；在会话数量数千以下性能完全够用。
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type {
  AIChatMessage,
  AIChatSession,
  AIChatSessionMeta,
  AIChatSearchHit,
} from '@shared/types'

// ── 目录 ───────────────────────────────────────
const CHATS_DIR = path.join(app.getPath('userData'), 'ai-chats')
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true })

// ── 原子写入 ───────────────────────────────────
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

function sessionFile(id: string): string {
  // 防止 id 带路径穿越
  const safe = id.replace(/[^a-zA-Z0-9_\-]/g, '')
  return path.join(CHATS_DIR, `${safe}.json`)
}

/**
 * 从会话中提取元数据（剥离 messages）
 */
function toMeta(s: AIChatSession): AIChatSessionMeta {
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
 * 基于消息数组生成标题与预览
 */
export function deriveMetaFromMessages(messages: AIChatMessage[]): { title: string; preview: string } {
  const firstUser = messages.find(m => m.role === 'user')?.content?.trim() ?? ''
  const title = firstUser ? firstUser.slice(0, 24) : '新对话'
  // 预览：取首个 user + 首个 assistant 的头部，足够在侧栏一行展示
  const firstAssistant = messages.find(m => m.role === 'assistant')?.content?.trim() ?? ''
  const preview = (firstUser + (firstAssistant ? '  ·  ' + firstAssistant : '')).replace(/\s+/g, ' ').slice(0, 80)
  return { title, preview }
}

// ── 列出 ───────────────────────────────────────
export function listSessions(): AIChatSessionMeta[] {
  if (!fs.existsSync(CHATS_DIR)) return []
  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'))
  const metas: AIChatSessionMeta[] = []
  for (const f of files) {
    const s = readJSON<AIChatSession | null>(path.join(CHATS_DIR, f), null)
    if (!s || !s.id) continue
    metas.push(toMeta(s))
  }
  // 按更新时间倒序
  return metas.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ── 读取 ───────────────────────────────────────
export function getSession(id: string): AIChatSession | null {
  return readJSON<AIChatSession | null>(sessionFile(id), null)
}

// ── 保存 ───────────────────────────────────────
export function saveSession(session: AIChatSession): AIChatSessionMeta {
  // 补齐 meta 字段：title / preview 在消息有变化时重新派生
  const now = Date.now()
  const derived = deriveMetaFromMessages(session.messages ?? [])
  const normalized: AIChatSession = {
    ...session,
    title: session.title && session.title.trim() && session.title !== '新对话'
      ? session.title
      : derived.title,
    preview: derived.preview,
    messageCount: session.messages?.length ?? 0,
    createdAt: session.createdAt || now,
    updatedAt: now,
  }
  atomicWrite(sessionFile(normalized.id), normalized)
  console.log(`[AIChatStore] 保存会话 id=${normalized.id} title=${normalized.title} msgs=${normalized.messageCount}`)
  return toMeta(normalized)
}

// ── 删除 ───────────────────────────────────────
export function deleteSession(id: string): boolean {
  const f = sessionFile(id)
  try {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f)
      console.log(`[AIChatStore] 删除会话 id=${id}`)
      return true
    }
  } catch (e) {
    console.error('[AIChatStore] 删除会话失败:', e)
  }
  return false
}

// ── 重命名 ─────────────────────────────────────
export function renameSession(id: string, title: string): boolean {
  const s = getSession(id)
  if (!s) return false
  s.title = title.trim().slice(0, 60) || s.title
  s.updatedAt = Date.now()
  atomicWrite(sessionFile(id), s)
  return true
}

// ── 搜索 ───────────────────────────────────────
/**
 * 全文搜索：在所有会话的标题 + 消息内容中查找子串（大小写不敏感）
 * 返回每条会话的最佳上下文片段
 */
export function searchSessions(query: string): AIChatSearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  if (!fs.existsSync(CHATS_DIR)) return []

  const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'))
  const hits: AIChatSearchHit[] = []

  for (const f of files) {
    const s = readJSON<AIChatSession | null>(path.join(CHATS_DIR, f), null)
    if (!s) continue

    let matchCount = 0
    let bestSnippet = ''
    const matchedMessageIds: string[] = []

    // 标题命中
    if (s.title.toLowerCase().includes(q)) matchCount++

    // 消息命中
    for (const m of s.messages ?? []) {
      const text = m.content ?? ''
      const lower = text.toLowerCase()
      let idx = lower.indexOf(q)
      if (idx === -1) continue

      matchedMessageIds.push(m.id)
      // 统计本条消息中出现次数（非重叠）
      while (idx !== -1) {
        matchCount++
        idx = lower.indexOf(q, idx + q.length)
      }

      // 生成上下文片段（取第一次出现处）
      if (!bestSnippet) {
        const first = lower.indexOf(q)
        const start = Math.max(0, first - 24)
        const end = Math.min(text.length, first + q.length + 60)
        bestSnippet =
          (start > 0 ? '…' : '') +
          text.slice(start, end).replace(/\s+/g, ' ') +
          (end < text.length ? '…' : '')
      }
    }

    if (matchCount > 0) {
      hits.push({
        sessionId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        snippet: bestSnippet || s.preview,
        matchCount,
        matchedMessageIds,
      })
    }
  }

  // 匹配多的优先，相同再按更新时间倒序
  return hits.sort((a, b) => b.matchCount - a.matchCount || b.updatedAt - a.updatedAt)
}
