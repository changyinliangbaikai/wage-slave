/**
 * 统一对话系统 IPC（CHAT_*）
 *
 * 取代分裂的 AI_CHAT_* 与 AGENT_* 启动/流式通道：
 *   - CHAT_START 根据 mode 自动分流到 DialogueService（chat / agent）
 *   - 所有流式事件统一从 CHAT_CHUNK / CHAT_TOOL_EVENT / CHAT_DONE / CHAT_ERROR 推送
 *   - 会话读写经 chat-store facade，合并两套既有存储（不破坏旧数据）
 *
 * 旧的 AI_CHAT_* / AGENT_* 处理器仍保留（向后兼容、旧窗口可用），
 * 本模块为新的统一对话窗口（#/chat）服务。
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'
import type { ChatStartParams, ChatSession, ChatStartResult } from '@shared/types-chat'
import { DialogueService } from './chat/dialogue-service'
import * as chatStore from './chat/chat-store'
import { getChatWindow, openChatWindow } from './windows'
import { agentActivityStarted, agentActivityEnded } from './agent/active-tracker'
import { getStoredApiKey } from './api-key'
import { getAgentSession, saveAgentSession } from './agent/session-store'
import { summarizeOnce } from './ai-chat-service'
import type { AgentMessage } from '@shared/types'

/**
 * 注册统一对话 IPC
 */
// 活跃对话实例表（按 sessionId 支持多会话并发）
const active = new Map<string, DialogueService>()

/** 强制中断所有活跃的后台对话及 Agent 执行（例如在窗口关闭时） */
export function abortAllActiveChats(): void {
  for (const service of active.values()) {
    try {
      service.abort()
    } catch (err) {
      log.warn('[ChatIPC] 批量中止对话失败:', err)
    }
  }
  active.clear()
}

export function registerChatIPC(): void {

  /** 把推送广播给统一对话窗口 */
  const broadcast = (channel: string, payload: unknown): void => {
    const win = getChatWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }

  // 打开统一对话窗口
  ipcMain.on(IPC.CHAT_OPEN_WINDOW, () => openChatWindow())

  // 发起一次对话（chat / agent）
  ipcMain.handle(IPC.CHAT_START, async (_e, params: ChatStartParams): Promise<ChatStartResult> => {
    if (!params?.userInput || !params.userInput.trim()) {
      return { ok: false, error: '输入不能为空' }
    }
    const { sessionId, mode } = params

    // 同会话已有活跃实例 → 先中止
    const existing = active.get(sessionId)
    if (existing) existing.abort()

    const apiKey = await getStoredApiKey()
    const service = new DialogueService()
    active.set(sessionId, service)

    // Agent 模式参与小猫活跃态（busy 动画）；chat 模式不影响
    if (mode === 'agent') agentActivityStarted('chat')

    service
      .start(params, apiKey, {
        onChunk: (p) => broadcast(IPC.CHAT_CHUNK, p),
        onToolEvent: (p) => broadcast(IPC.CHAT_TOOL_EVENT, p),
        onDone: (p) => {
          broadcast(IPC.CHAT_DONE, p)
          active.delete(sessionId)
        },
        onError: (p) => {
          broadcast(IPC.CHAT_ERROR, p)
          if (p.fatal) active.delete(sessionId)
        },
      })
      .catch((err) => {
        log.error('[ChatIPC] 对话执行未捕获异常:', err)
        broadcast(IPC.CHAT_ERROR, {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
          fatal: true,
        })
        active.delete(sessionId)
      })
      .finally(() => {
        if (mode === 'agent') agentActivityEnded('chat')
      })

    return { ok: true, sessionId }
  })

  // 中止对话
  ipcMain.handle(IPC.CHAT_STOP, (_e, params: { sessionId: string }) => {
    const service = active.get(params.sessionId)
    if (!service) return { ok: false, error: '无活跃对话' }
    service.abort()
    return { ok: true }
  })

  // ── 会话管理（合并 chat + agent 存储） ──────────
  // 支持按 projectId 过滤：renderer 可传 { projectId } 或 string 形式的 projectId
  ipcMain.handle(IPC.CHAT_LIST_SESSIONS, (_e, opts?: { projectId?: string } | string) => {
    if (typeof opts === 'string') return chatStore.listSessions({ projectId: opts })
    return chatStore.listSessions(opts)
  })
  ipcMain.handle(IPC.CHAT_GET_SESSION, (_e, id: string) => chatStore.getSession(id))
  ipcMain.handle(IPC.CHAT_SAVE_SESSION, (_e, session: ChatSession) => chatStore.saveSession(session))
  ipcMain.handle(IPC.CHAT_DELETE_SESSION, (_e, id: string) => ({ ok: chatStore.deleteSession(id) }))
  ipcMain.handle(IPC.CHAT_RENAME_SESSION, (_e, params: { id: string; title: string }) => ({
    ok: chatStore.renameSession(params.id, params.title),
  }))
  ipcMain.handle(IPC.CHAT_SEARCH, (_e, query: string) => chatStore.searchSessions(query))

  /**
   * 永久压缩当前会话：把首条 user 之外、最后 4 条之前的中间历史替换为 LLM 摘要
   * 参考 Claude Code 的 compactConversation：非对称摘要 + 物理替换
   *
   * 流程：
   *  1. 读取 AgentSession，校验消息条数（< 6 直接返回）
   *  2. 切出中间段，构造 user/assistant/tool 对话纯文本
   *  3. 调用 summarizeOnce 生成 400 字以内的摘要
   *  4. 用一条特殊 user 消息（标记 [早期会话已手动压缩]）替换中间段
   *  5. 物理写回 JSON
   */
  ipcMain.handle(IPC.CHAT_COMPACT_SESSION, async (_e, sessionId: string): Promise<{ ok: boolean; error?: string; summary?: string; removed?: number }> => {
    try {
      if (!sessionId) return { ok: false, error: '缺少 sessionId' }
      // 当前 /compact 仅支持 Agent 模式会话（agent_ 前缀）
      if (!sessionId.startsWith('agent_')) {
        return { ok: false, error: '/compact 仅对 Agent 会话生效' }
      }
      const session = getAgentSession(sessionId)
      if (!session) return { ok: false, error: '会话不存在' }
      const msgs = session.messages ?? []
      if (msgs.length < 6) {
        return { ok: false, error: '消息过少，无需压缩（至少 6 条）' }
      }
      // 切片：保留首条 user + 最近 4 条（含本轮 assistant/tool），中间段做摘要
      const firstUserIdx = msgs.findIndex(m => m.role === 'user')
      const keepHead: AgentMessage[] = firstUserIdx >= 0
        ? msgs.slice(0, firstUserIdx + 1)
        : msgs.slice(0, 1)
      const tailKeep = 4
      const keepTail = msgs.slice(-tailKeep)
      // 中间段就是 keepHead 之后、keepTail 之前的部分
      const headEnd = keepHead.length
      const tailStart = msgs.length - tailKeep
      if (tailStart <= headEnd) {
        return { ok: false, error: '消息分布不足以压缩' }
      }
      const middle = msgs.slice(headEnd, tailStart)

      // 拼接中间段文本（去掉空 content；tool 消息只保留前 800 字防爆 prompt）
      const segText = middle.map(m => {
        const tag = m.role === 'tool' ? `[tool:${m.tool_name ?? ''}]` : `[${m.role}]`
        const content = (m.content ?? '').replace(/\s+/g, ' ').slice(0, m.role === 'tool' ? 800 : 4000)
        return `${tag} ${content}`
      }).join('\n')

      const apiKey = await getStoredApiKey()
      const summary = await summarizeOnce({
        apiKey,
        systemPrompt: '你是一个对话摘要助手。请用不超过 400 字的中文，提炼下述对话中的关键决策、已完成动作与未决问题，以便后续对话可以继续。不要寒暄，不要罗列时间，直奔要点。',
        userPrompt: `以下是需要压缩的对话片段（共 ${middle.length} 条）：\n\n${segText}`,
        maxTokens: 800,
        temperature: 0.3,
      })

      // 用一条特殊 user 消息替换中间段
      const placeholder: AgentMessage = {
        id: `user_compact_${Date.now()}`,
        role: 'user',
        content: `[早期会话已手动压缩，以下为前情概要]：\n${summary || '（摘要为空，已折叠中间消息）'}`,
        createdAt: Date.now(),
      }
      const nextMessages = [...keepHead, placeholder, ...keepTail]
      saveAgentSession({ ...session, messages: nextMessages })
      log.info(`[Compact] sessionId=${sessionId} 中间 ${middle.length} 条 → 摘要 ${summary.length} 字`)
      return { ok: true, summary, removed: middle.length }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('[Compact] 失败:', msg)
      return { ok: false, error: msg }
    }
  })
}
