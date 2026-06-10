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

// keytar 可能在部分环境缺失（与既有逻辑一致，降级为空 key）
let keytar: typeof import('keytar') | null = null
try {
  keytar = require('keytar')
} catch {
  keytar = null
}
const KEYTAR_SERVICE = 'xiao-niu-ma'
const KEYTAR_ACCOUNT = 'api-key'

async function getApiKey(): Promise<string> {
  if (!keytar) return ''
  try {
    return (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT)) ?? ''
  } catch (e) {
    // 无可用密钥后端（如缺少 libsecret/D-Bus）时降级为空，交由下游提示「未配置 API Key」
    log.warn('[ChatIPC] 读取 API Key 失败，降级为空:', e)
    return ''
  }
}

/**
 * 注册统一对话 IPC
 */
export function registerChatIPC(): void {
  // 活跃对话实例表（按 sessionId 支持多会话并发）
  const active = new Map<string, DialogueService>()

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

    const apiKey = await getApiKey()
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
  ipcMain.handle(IPC.CHAT_LIST_SESSIONS, () => chatStore.listSessions())
  ipcMain.handle(IPC.CHAT_GET_SESSION, (_e, id: string) => chatStore.getSession(id))
  ipcMain.handle(IPC.CHAT_SAVE_SESSION, (_e, session: ChatSession) => chatStore.saveSession(session))
  ipcMain.handle(IPC.CHAT_DELETE_SESSION, (_e, id: string) => ({ ok: chatStore.deleteSession(id) }))
  ipcMain.handle(IPC.CHAT_RENAME_SESSION, (_e, params: { id: string; title: string }) => ({
    ok: chatStore.renameSession(params.id, params.title),
  }))
  ipcMain.handle(IPC.CHAT_SEARCH, (_e, query: string) => chatStore.searchSessions(query))
}
