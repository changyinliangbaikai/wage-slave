/**
 * 统一对话服务（主进程）
 *
 * 职责：根据 ChatStartParams.mode 自动选择执行策略，并把两套底层服务的
 * 流式事件适配成统一的 ChatCallbacks：
 *   - 'chat'  → ai-chat-service.startChat（单轮流式）
 *   - 'agent' → agent/orchestrator.AgentOrchestrator（多轮 + 工具）
 *
 * 一个 DialogueService 实例对应一次「用户提交 → 完成/中止」的执行周期。
 */

import log from 'electron-log/main'
import type { AgentMessage, AIChatAttachment } from '@shared/types'
import type {
  ChatStartParams,
  ChatChunkPayload,
  ChatToolEventPayload,
  ChatDonePayload,
  ChatErrorPayload,
} from '@shared/types-chat'

import { startChat as startSimpleChat, abortChat as abortSimpleChat } from '../ai-chat-service'
import { AgentOrchestrator } from '../agent/orchestrator'
import { getAgentSession } from '../agent/session-store'

export interface DialogueCallbacks {
  onChunk: (payload: ChatChunkPayload) => void
  onDone: (payload: ChatDonePayload) => void
  onError: (payload: ChatErrorPayload) => void
  /** 仅 Agent 模式：工具调用状态推送 */
  onToolEvent: (payload: ChatToolEventPayload) => void
}

function buildContentWithAttachments(text: string, attachments: AIChatAttachment[]): string {
  const blocks = attachments.map((a, i) => {
    return `[附件 #${i + 1} - ${a.fileName} (${a.fileType})]\n${a.content}\n[附件 #${i + 1} 结束]\n`
  })
  return `我提供了 ${attachments.length} 个附件作为上下文，请阅读后回答我的问题。
用户输入：
${text}

---
附件上下文：
${blocks.join('\n')}`
}

export class DialogueService {
  private orchestrator: AgentOrchestrator | null = null
  private chatRequestId: string | null = null
  private sessionId = ''

  /** 当前会话 id（供外部登记/查询） */
  get currentSessionId(): string {
    return this.sessionId
  }

  async start(params: ChatStartParams, apiKey: string, cb: DialogueCallbacks): Promise<void> {
    this.sessionId = params.sessionId
    if (params.mode === 'agent') {
      await this.runAgent(params, apiKey, cb)
    } else {
      await this.runChat(params, apiKey, cb)
    }
  }

  /** 中止当前执行（chat / agent 均覆盖） */
  abort(): void {
    this.orchestrator?.abort()
    if (this.chatRequestId) abortSimpleChat(this.chatRequestId)
  }

  // ── 简单对话模式 ──────────────────────────────
  private async runChat(params: ChatStartParams, apiKey: string, cb: DialogueCallbacks): Promise<void> {
    const sessionId = params.sessionId
    const requestId = params.assistantMessageId ?? `${sessionId}_${Date.now()}`
    this.chatRequestId = requestId

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (params.systemPrompt && params.systemPrompt.trim()) {
      messages.push({ role: 'system', content: params.systemPrompt.trim() })
    }
    for (const m of params.history ?? []) {
      if (m.role === 'tool' || m.role === 'system') continue
      const content = m.attachments && m.attachments.length > 0
        ? buildContentWithAttachments(m.content, m.attachments)
        : m.content
      messages.push({ role: m.role, content })
    }
    const userInput = params.attachments && params.attachments.length > 0
      ? buildContentWithAttachments(params.userInput, params.attachments)
      : params.userInput
    messages.push({ role: 'user', content: userInput })

    await startSimpleChat({ requestId, messages }, apiKey, {
      onChunk: (p) =>
        cb.onChunk({ sessionId, messageId: requestId, content: p.content, reasoning: p.reasoning }),
      onDone: (p) =>
        cb.onDone({
          sessionId,
          messageId: requestId,
          content: p.content,
          reasoning: p.reasoning,
          stats: p.stats,
        }),
      onError: (p) =>
        cb.onError({ sessionId, messageId: requestId, error: p.error, fatal: true }),
    })
  }

  // ── Agent 工具模式 ────────────────────────────
  private async runAgent(params: ChatStartParams, apiKey: string, cb: DialogueCallbacks): Promise<void> {
    const sessionId = params.sessionId
    const orchestrator = new AgentOrchestrator(sessionId)
    this.orchestrator = orchestrator

    // 继续会话：从 Agent 存储加载历史
    let history: AgentMessage[] = []
    const session = getAgentSession(sessionId)
    if (session) history = session.messages

    log.info(`[Dialogue] agent 模式启动 sessionId=${sessionId}, 历史=${history.length} 条`)

    await orchestrator.run({
      userInput: params.userInput,
      attachments: params.attachments,
      apiKey,
      history,
      maxIterations: params.maxIterations,
      callbacks: {
        onChunk: (p) =>
          cb.onChunk({ sessionId, content: p.content, reasoning: p.reasoning, iteration: p.iteration }),
        onDone: (p) =>
          cb.onDone({
            sessionId,
            content: p.content,
            agentStats: p.stats,
            aborted: p.aborted,
          }),
        onError: (p) => cb.onError({ sessionId, error: p.error, fatal: p.fatal }),
        onToolStart: (p) =>
          cb.onToolEvent({
            sessionId,
            phase: 'start',
            iteration: p.iteration,
            toolCalls: p.toolCalls,
          }),
        onToolExecuting: (p) =>
          cb.onToolEvent({
            sessionId,
            phase: 'executing',
            toolId: p.toolId,
            toolName: p.toolName,
          }),
        onToolExecuted: (p) =>
          cb.onToolEvent({
            sessionId,
            phase: 'executed',
            toolId: p.toolId,
            toolName: p.toolName,
            success: p.success,
            output: p.output,
            error: p.error,
            durationMs: p.durationMs,
          }),
      },
    })
  }
}
