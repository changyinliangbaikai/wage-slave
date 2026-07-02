/**
 * 统一对话服务（主进程，仅 Agent 模式）
 *
 * 现版本已废弃「快速对话」单轮流，所有会话统一走 AgentOrchestrator（多轮 + 工具）。
 * 即便上层传入 mode === 'chat'，也强制升级为 agent 模式执行，
 * 以彻底消除双轨制代码（见 plan/next-steps-optimization.md §1）。
 *
 * 一个 DialogueService 实例对应一次「用户提交 → 完成/中止」的执行周期。
 */

import log from 'electron-log/main'
import type { AgentMessage } from '@shared/types'
import type {
  ChatStartParams,
  ChatChunkPayload,
  ChatToolEventPayload,
  ChatDonePayload,
  ChatErrorPayload,
} from '@shared/types-chat'

import { AgentOrchestrator } from '../agent/orchestrator'
import { getAgentSession } from '../agent/session-store'
import { getProject, getDefaultProject } from './project-store'

export interface DialogueCallbacks {
  onChunk: (payload: ChatChunkPayload) => void
  onDone: (payload: ChatDonePayload) => void
  onError: (payload: ChatErrorPayload) => void
  /** 工具调用状态推送（仅 Agent 模式有效，保留命名以维持 IPC 兼容） */
  onToolEvent: (payload: ChatToolEventPayload) => void
}

export class DialogueService {
  private orchestrator: AgentOrchestrator | null = null
  private sessionId = ''

  /** 当前会话 id（供外部登记/查询） */
  get currentSessionId(): string {
    return this.sessionId
  }

  /**
   * 启动一次对话执行
   * 不再区分 chat / agent 模式：统一走 Agent 工具栈，简化心智
   */
  async start(params: ChatStartParams, apiKey: string, cb: DialogueCallbacks): Promise<void> {
    this.sessionId = params.sessionId
    if (params.mode === 'chat') {
      log.info(`[Dialogue] 收到 mode=chat 请求 sessionId=${this.sessionId}，自动升级为 agent 模式执行`)
    }
    await this.runAgent(params, apiKey, cb)
  }

  /** 中止当前执行（仅作用于 Agent 编排器） */
  abort(): void {
    this.orchestrator?.abort()
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

    // 解析当前会话所属项目：优先用前端传入的 projectId，否则用历史会话记录，最后回退 default
    const projectId = params.projectId
      ?? session?.projectId
      ?? 'default'
    const project = getProject(projectId) ?? getDefaultProject()
    const projectCwd = session?.cwd ?? project.path

    log.info(`[Dialogue] agent 模式启动 sessionId=${sessionId}, 历史=${history.length} 条, projectId=${projectId}, cwd=${projectCwd}`)

    await orchestrator.run({
      userInput: params.userInput,
      attachments: params.attachments,
      apiKey,
      history,
      maxIterations: params.maxIterations,
      // 把项目上下文贯穿到 Agent 执行流，保证工具相对路径基于项目根解析
      projectId: project.id,
      projectCwd,
      callbacks: {
        onChunk: (p) =>
          cb.onChunk({ sessionId, content: p.content, reasoning: p.reasoning, iteration: p.iteration }),
        onDone: (p) =>
          cb.onDone({
            sessionId,
            content: p.content,
            agentStats: p.stats,
            tokenUsage: p.tokenUsage,
            aborted: p.aborted,
          }),
        onError: (p) => cb.onError({ sessionId, error: p.error, fatal: p.fatal }),
        onToolStart: (p) =>
          cb.onToolEvent({
            sessionId,
            phase: 'start',
            iteration: p.iteration,
            toolCalls: p.toolCalls,
            tokenUsage: p.tokenUsage,
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
