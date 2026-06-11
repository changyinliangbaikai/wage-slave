/**
 * Agent 编排器
 *
 * 多轮循环：
 *  1. 构建 System Prompt + History → 流式调用 LLM
 *  2. LLM 返回 tool_calls → 并发执行工具 → 把结果回灌 history → 进入下一轮
 *  3. LLM 返回纯文本（finish_reason=stop）→ 结束并把累计内容写入会话
 *
 * 关键约束：
 *  - maxIterations 防止死循环（默认 20 轮）
 *  - 每一轮都重建 AgentContext（保持时间/待办/日志状态最新）
 *  - 工具结果通过 IPC 实时推送给 UI（边执行边显示）
 */

import log from 'electron-log/main'
import type {
  AgentMessage,
  AgentSession,
  AgentToolCall,
  AgentToolResult,
  AgentChunkPayload,
  AgentDonePayload,
  AgentErrorPayload,
  AgentToolStartPayload,
  AgentToolExecutingPayload,
  AgentToolExecutedPayload,
  AIChatAttachment,
} from '@shared/types'
import { buildSystemPrompt, buildAgentContext } from './system-prompt'
import { getActiveToolSchemas, getToolDescription } from './tool-registry'
import { executeTool } from './tool-executor'
import { streamLLMWithTools } from './llm-tool-client'
import { saveAgentSession } from './session-store'
import { matchSkill, buildSkillPromptAddition } from './skills/matcher'
import { compressHistoryForLLM } from './context-compressor'
import { getToolSafety } from './security'
import { getConfig } from '../store'

/** 编排器最大迭代轮次，防止 LLM 反复调用工具死循环 */
const DEFAULT_MAX_ITERATIONS = 20

/** Agent 流式回调集合 */
export interface AgentCallbacks {
  onChunk: (payload: AgentChunkPayload) => void
  onDone: (payload: AgentDonePayload) => void
  onError: (payload: AgentErrorPayload) => void
  onToolStart: (payload: AgentToolStartPayload) => void
  onToolExecuting: (payload: AgentToolExecutingPayload) => void
  onToolExecuted: (payload: AgentToolExecutedPayload) => void
}

export interface AgentRunOptions {
  /** 用户输入 */
  userInput: string
  /** API Key（外部传入，避免每轮再异步读 keytar） */
  apiKey: string
  /** 历史消息（不含本轮 user） */
  history: AgentMessage[]
  /** 可选：附件列表 */
  attachments?: AIChatAttachment[]
  /** 可选：覆盖本次执行的最大迭代轮次 */
  maxIterations?: number
  /** 可选：本次执行超时时间 */
  timeoutMs?: number
  /** 流式回调 */
  callbacks: AgentCallbacks
}

/**
 * Agent 编排器
 * 一个实例对应一次"用户提交 → Agent 完成或被中止"的执行周期
 */
export class AgentOrchestrator {
  private readonly sessionId: string
  /** 当前累计的全部消息（含 system 之外的所有轮次） */
  private history: AgentMessage[] = []
  /** 用户主动中断器 */
  private abortController: AbortController | null = null
  /** 是否处于运行状态 */
  private running = false
  /** 累计统计 */
  private stats = { iterations: 0, toolCalls: 0, totalDurationMs: 0 }

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  isRunning(): boolean {
    return this.running
  }

  abort(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      log.info(`[Agent] 用户主动中断 sessionId=${this.sessionId}`)
      this.abortController.abort()
    }
  }

  /** 执行一次任务 */
  async run(opts: AgentRunOptions): Promise<void> {
    if (this.running) throw new Error('Agent 正在运行，请先停止')

    this.running = true
    this.abortController = new AbortController()
    this.history = [...opts.history]
    this.stats = { iterations: 0, toolCalls: 0, totalDurationMs: 0 }
    const overallStart = Date.now()
    const maxIterations = getMaxIterations(opts.maxIterations)
    const timeoutMs = normalizeTimeoutMs(opts.timeoutMs)
    let timedOut = false
    const timeoutTimer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          this.abortController?.abort()
        }, timeoutMs)
      : null

    // ── 把用户输入加入 history ──
    const userMsg: AgentMessage = {
      id: genMsgId('user'),
      role: 'user',
      content: opts.userInput,
      attachments: opts.attachments,
      createdAt: Date.now(),
    }
    this.history.push(userMsg)

    // ── 技能匹配：基于用户输入命中一个已启用 skill，整轮注入其引导 ──
    const matched = matchSkill(opts.userInput)
    const skillAddition = matched ? buildSkillPromptAddition(matched.skill) : undefined
    if (matched) {
      log.info(`[Agent] sessionId=${this.sessionId} 激活技能: ${matched.skill.name}`)
    }

    let finalContent = ''

    try {
      while (this.stats.iterations < maxIterations) {
        if (this.abortController.signal.aborted) break

        this.stats.iterations++
        log.info(`[Agent] 第 ${this.stats.iterations} 轮 sessionId=${this.sessionId}`)

        // 每轮都重新构建 system prompt（注入最新时间/待办状态 + 命中的技能引导）
        const systemPrompt = buildSystemPrompt(buildAgentContext(), skillAddition)
        const tools = getActiveToolSchemas()
        // 压缩历史：仅本轮 LLM 调用使用，this.history 保持完整以便会话持久化
        const compressedHistory = compressHistoryForLLM(this.history)
        const apiMessages = [
          { role: 'system' as const, content: systemPrompt },
          ...compressedHistory.map(m => historyToApi(m)),
        ]

        // ── 调用 LLM（流式） ──
        const result = await streamLLMWithTools({
          messages: apiMessages,
          tools,
          apiKey: opts.apiKey,
          signal: this.abortController.signal,
          onDelta: ({ content, reasoning }) => {
            opts.callbacks.onChunk({
              sessionId: this.sessionId,
              content,
              reasoning,
              iteration: this.stats.iterations,
            })
          },
        })

        if (result.aborted) break

        // ── 把 assistant 这一轮的产出写入 history ──
        const assistantMsg: AgentMessage = {
          id: genMsgId('asst'),
          role: 'assistant',
          content: result.content,
          reasoning: result.reasoning || undefined,
          tool_calls: result.toolCalls.length > 0
            ? result.toolCalls.map(tc => ({
                id: tc.id,
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              }))
            : undefined,
          createdAt: Date.now(),
        }
        this.history.push(assistantMsg)

        // ── 没有工具调用 → 任务完成 ──
        if (result.toolCalls.length === 0) {
          finalContent = result.content
          break
        }

        // ── 有工具调用 → 推送 → 执行 → 回灌 history ──
        opts.callbacks.onToolStart({
          sessionId: this.sessionId,
          iteration: this.stats.iterations,
          toolCalls: result.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            description: getToolDescription(tc.name),
            safetyLevel: getToolSafety(tc.name),
            arguments: tc.arguments,
          })),
        })

        const toolResults = await this.executeAllTools(result.toolCalls, opts.callbacks)
        this.stats.toolCalls += toolResults.length

        // 把 tool 结果作为 role=tool 消息追加
        for (const tr of toolResults) {
          this.history.push({
            id: genMsgId('tool'),
            role: 'tool',
            content: tr.error ? `[ERROR] ${tr.error}` : tr.output,
            tool_call_id: tr.toolCallId,
            tool_name: tr.toolName,
            createdAt: Date.now(),
          })
        }

        // 任一 fatal 错误 → 中止
        const fatal = toolResults.find(t => t.fatal)
        if (fatal) {
          opts.callbacks.onError({
            sessionId: this.sessionId,
            error: `工具 ${fatal.toolName} 致命错误: ${fatal.error}`,
            fatal: true,
          })
          finalContent = `❌ 执行中止：工具 ${fatal.toolName} 报告致命错误`
          break
        }

        // 否则进入下一轮迭代
      }

      // ── 兜底：达到最大轮次 ──
      if (this.stats.iterations >= maxIterations && !finalContent) {
        finalContent = `⚠️ 已达最大迭代轮次（${maxIterations}），任务未在限定步数内完成。`
        this.history.push({
          id: genMsgId('asst'),
          role: 'assistant',
          content: finalContent,
          createdAt: Date.now(),
        })
      }

      // ── 收尾：写持久化 + done 事件 ──
      this.stats.totalDurationMs = Date.now() - overallStart
      this.persistSession(finalContent)

      // 判断是否因中断而跳出循环（result.aborted=true 会走到这里，不是 catch）
      const wasAborted = this.abortController?.signal.aborted === true
      if (wasAborted) log.info(`[Agent] 任务在中断后收尾 sessionId=${this.sessionId}`)
      opts.callbacks.onDone({
        sessionId: this.sessionId,
        content: finalContent,
        iterations: this.stats.iterations,
        stats: { ...this.stats },
        aborted: wasAborted,
        abortReason: wasAborted ? (timedOut ? 'timeout' : 'user') : undefined,
      })
    } catch (e: unknown) {
      // 用户主动中断：当作"已完成"处理（保留已经产生的部分）
      if (isAbortError(e) || this.abortController.signal.aborted) {
        this.stats.totalDurationMs = Date.now() - overallStart
        this.persistSession(finalContent || '(用户中断)')
        opts.callbacks.onDone({
          sessionId: this.sessionId,
          content: finalContent || '(用户中断)',
          iterations: this.stats.iterations,
          stats: { ...this.stats },
          aborted: true,
          abortReason: timedOut ? 'timeout' : 'user',
        })
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        log.error(`[Agent] 执行异常 sessionId=${this.sessionId}:`, msg)
        opts.callbacks.onError({
          sessionId: this.sessionId,
          error: msg,
          fatal: true,
        })
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      this.running = false
      this.abortController = null
    }
  }

  /**
   * 执行一组工具调用（顺序执行，避免对本地数据并发写竞争）
   * 每一步都通过 IPC 推送，让 UI 实时看到进度
   */
  private async executeAllTools(
    toolCalls: AgentToolCall[],
    cb: AgentCallbacks,
  ): Promise<AgentToolResult[]> {
    const results: AgentToolResult[] = []
    for (const tc of toolCalls) {
      cb.onToolExecuting({
        sessionId: this.sessionId,
        toolId: tc.id,
        toolName: tc.name,
      })

      const result = await executeTool(tc)
      results.push(result)

      cb.onToolExecuted({
        sessionId: this.sessionId,
        toolId: tc.id,
        toolName: tc.name,
        success: !result.error,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
      })
    }
    return results
  }

  /**
   * 把当前 history 写入会话存储
   * 标题由首条 user 消息生成
   */
  private persistSession(latestContent: string): void {
    try {
      const firstUser = this.history.find(m => m.role === 'user')
      const title = (firstUser?.content ?? '新会话').slice(0, 24) || '新会话'
      const preview = (firstUser?.content ?? '').replace(/\s+/g, ' ').slice(0, 80)
      const now = Date.now()
      const session: AgentSession = {
        id: this.sessionId,
        title,
        createdAt: this.history[0]?.createdAt ?? now,
        updatedAt: now,
        messageCount: this.history.length,
        preview,
        messages: this.history,
        stats: { ...this.stats },
      }
      saveAgentSession(session)
      log.info(`[Agent] 持久化会话 id=${this.sessionId} msgs=${this.history.length} latestLen=${latestContent.length}`)
    } catch (e) {
      log.warn('[Agent] 持久化失败:', e)
    }
  }
}

/**
 * 把 AgentMessage 转为 OpenAI API 消息格式
 *  - assistant 含 tool_calls 时按 OpenAI function calling 协议序列化
 *  - tool 角色必须带 tool_call_id
 *  - user 角色含 attachments 时拼接附件内容
 */
function historyToApi(m: AgentMessage): {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
} {
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || '',
      tool_calls: m.tool_calls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    }
  }
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.tool_call_id ?? '',
      name: m.tool_name,
    }
  }

  // user 角色：如果有附件，拼接附件内容到 content
  if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
    const content = buildContentWithAttachments(m.content, m.attachments)
    return { role: m.role, content }
  }

  return { role: m.role, content: m.content }
}

/**
 * 把附件内容拼接到用户提问前面，形成给 LLM 的完整 prompt
 */
function buildContentWithAttachments(text: string, attachments: AIChatAttachment[]): string {
  const blocks = attachments.map((a, i) => {
    const meta = `${a.fileName} · ${formatFileSize(a.sizeBytes)}${a.truncated ? ` · 已截取前 ${a.content.length} 字（原文 ${a.charCount} 字）` : ''}`
    // 用 Markdown 代码块包裹文件内容，最大限度保留原始格式
    return `### 📎 附件 ${i + 1}：${meta}
\`\`\`
${a.content}
\`\`\``
  }).join('\n\n')

  const question = text.trim() || '请基于以上附件内容给出回答。'
  return `我提供了 ${attachments.length} 个附件作为上下文，请阅读后回答我的问题。

${blocks}

**我的问题**：${question}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function genMsgId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getMaxIterations(override?: number): number {
  const configured = typeof override === 'number' ? override : getConfig().agent_max_iterations
  if (typeof configured !== 'number' || Number.isNaN(configured)) return DEFAULT_MAX_ITERATIONS
  return Math.max(1, Math.min(50, Math.floor(configured)))
}

function normalizeTimeoutMs(value?: number): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return undefined
  return Math.max(1_000, Math.min(24 * 60 * 60 * 1000, Math.floor(value)))
}

function isAbortError(e: unknown): boolean {
  return Boolean(e) && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}
