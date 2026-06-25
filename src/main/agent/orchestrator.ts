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
import { buildSystemPrompt, buildAgentContext, buildDynamicContext } from './system-prompt'
import { getActiveToolSchemas, getToolDescription } from './tool-registry'
import { executeTool } from './tool-executor'
import { streamLLMWithTools } from './llm-tool-client'
import { saveAgentSession } from './session-store'
import { matchSkill, buildSkillPromptAddition } from './skills/matcher'
import { compressHistoryForLLM } from './context-compressor'
import { getToolSafety } from './security'
import { getConfig } from '../store'
import { MemoryTraceCollector } from './trace-collector'

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
  /** 当前会话归属的项目 id（用于路径白名单与 cwd 注入） */
  projectId?: string
  /** 当前项目的绝对工作目录（贯穿整个执行，作为相对路径解析基准） */
  projectCwd?: string
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
  /** 最近一轮 LLM 调用的 Token 使用量（用于 onDone 回传给前端显示上下文占比） */
  private latestTokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    maxTokens: number
    iteration?: number
  } | null = null
  /** 当前会话归属的项目 id（默认 'default'） */
  private projectId: string = 'default'
  /** 当前项目的工作目录（绝对路径，作为相对路径解析基准） */
  private projectCwd: string = process.cwd()

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

    // 锁定本次执行所属的项目上下文（projectId + projectCwd），贯穿全部工具调用
    if (opts.projectId) this.projectId = opts.projectId
    if (opts.projectCwd) this.projectCwd = opts.projectCwd
    log.info(`[Agent] 项目上下文 sessionId=${this.sessionId} projectId=${this.projectId} cwd=${this.projectCwd}`)

    const collector = new MemoryTraceCollector(this.sessionId)
    const curRunId = collector.getRunId()
    let totalPromptTokens = 0
    let totalCompletionTokens = 0

    collector.record('run.start', {
      name: `小牛马任务 · ${opts.userInput.slice(0, 30)}`,
      model: getConfig().llm_model || 'default-model',
      modelProvider: 'openai-compatible',
      promptVersion: 'xiao-niu-ma-prompt@2.1.0',
      skillVersions: ['xiao-niu-ma-agent@2.1.0'],
      toolSchemaVersion: 'xiao-niu-ma-tools@v2.1',
      runtimeVersion: 'xiao-niu-ma-runtime@2.1.0',
      contextStrategyVersion: 'default',
      agentId: 'xiao-niu-ma',
      agentName: '小小牛马',
      agentDescription: '集成在 Jarvis Studio 中的本地桌面助手智能体（小小牛马）。'
    })

    const files = opts.attachments
      ? opts.attachments.map(att => ({ path: att.path || '' }))
      : []

    collector.record('turn.start', {
      index: 1,
      userMessage: opts.userInput,
      files
    })

    this.running = true
    this.abortController = new AbortController()

    const overallStart = Date.now()
    const maxIterations = getMaxIterations(opts.maxIterations)
    const timeoutMs = normalizeTimeoutMs(opts.timeoutMs)
    let timedOut = false
    let executionStatus: 'success' | 'failed' = 'failed'
    let finalContent = ''
    let timeoutTimer: any = null

    try {
      timeoutTimer = timeoutMs
        ? setTimeout(() => {
            timedOut = true
            this.abortController?.abort()
          }, timeoutMs)
        : null

      this.history = [...opts.history]
      this.stats = { iterations: 0, toolCalls: 0, totalDurationMs: 0 }

      // ── 技能匹配：基于用户输入命中一个已启用 skill，整轮注入其引导 ──
      const matched = matchSkill(opts.userInput)
      const skillAddition = matched ? buildSkillPromptAddition(matched.skill) : undefined
      if (matched) {
        log.info(`[Agent] sessionId=${this.sessionId} 激活技能: ${matched.skill.name}`)
      }

      // ── 把用户输入加入 history（同时挂载一次性静态环境快照以供 Prompt Caching） ──
      const userMsg: AgentMessage = {
        id: genMsgId('user'),
        role: 'user',
        content: opts.userInput,
        attachments: opts.attachments,
        createdAt: Date.now(),
      }
      // 上下文构建使用项目 cwd（绑定到当前会话的项目），避免依赖 process.cwd
      ;(userMsg as any).dynamicContext = await buildDynamicContext(buildAgentContext(this.projectCwd))
      if (skillAddition) {
        ;(userMsg as any).skillAdditionText = `\n# === 激活技能 ===\n${skillAddition}`
      }
      this.history.push(userMsg)

      while (this.stats.iterations < maxIterations) {
        if (this.abortController.signal.aborted) break

        this.stats.iterations++
        log.info(`[Agent] 第 ${this.stats.iterations} 轮 sessionId=${this.sessionId}`)

        // 每轮都获取静态 system prompt（支持长期 Prompt Caching）
        const systemPrompt = buildSystemPrompt()
        const tools = getActiveToolSchemas()
        // 压缩历史：仅本轮 LLM 调用使用，this.history 保持完整以便会话持久化
        const compressedHistory = compressHistoryForLLM(this.history)
        const apiMessages = [
          { role: 'system' as const, content: systemPrompt },
          ...compressedHistory.map(m => historyToApi(m)),
        ]

        // 动态环境上下文与激活技能已被永久挂载在 user 消息中，此处无需再次拼接，保证 history 链条内容一致

        const contextSnapshotId = `ctx_snap_${Math.random().toString(36).slice(2, 9)}`
        const contextSpanId = `span_ctx_${Math.random().toString(36).slice(2, 9)}`

        const segments = [
          {
            id: `seg_system_prompt_${Math.random().toString(36).slice(2, 9)}`,
            type: 'system_prompt',
            name: 'xiao-niu-ma-system-prompt',
            version: '2.1.0',
            preview: systemPrompt,
            tokens: 0,
            included: true,
            priority: 100,
            action: 'keep'
          },
          {
            id: `seg_available_tools_${Math.random().toString(36).slice(2, 9)}`,
            type: 'tool_descriptions',
            name: 'available-tools',
            preview: tools.map(t => t.function.name).join(', '),
            tokens: 0,
            included: true,
            priority: 80,
            action: 'keep',
            metadata_json: JSON.stringify(tools),
            tools: tools
          },
          {
            id: `seg_conversation_history_${Math.random().toString(36).slice(2, 9)}`,
            type: 'conversation_history',
            name: 'previous-turns',
            preview: compressedHistory.map(h => `${h.role}: ${h.content}`).join('\n'),
            tokens: 0,
            included: true,
            priority: 60,
            action: 'keep'
          }
        ]

        collector.record('context.build', {
          contextSnapshotId,
          totalTokens: 0,
          maxContextTokens: 32768,
          finalPrompt: systemPrompt + '\n' + compressedHistory.map(h => `${h.role}: ${h.content}`).join('\n'),
          segments,
          input: {
            userInput: opts.userInput,
            historyCount: compressedHistory.length,
            skill: matched ? matched.skill.name : 'none'
          }
        }, { spanId: contextSpanId })

        // ── 调用 LLM（流式） ──
        const llmStart = Date.now()
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
        const latencyMs = Date.now() - llmStart

        const promptTokens = result.usage?.prompt_tokens ?? 0
        const completionTokens = result.usage?.completion_tokens ?? 0
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens)
        const maxTokens = inferModelMaxTokens()
        totalPromptTokens += promptTokens
        totalCompletionTokens += completionTokens

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
          // 持久化本轮 Token 使用量，便于会话载入后前端继续显示占比
          metadata: {
            model: getConfig().agent_llm_model || getConfig().llm_model,
            iteration: this.stats.iterations,
            promptTokens,
            completionTokens,
            totalTokens,
            maxTokens,
          },
          createdAt: Date.now(),
        }
        this.history.push(assistantMsg)

        // 用于回传给前端的 tokenUsage 对象
        const tokenUsage = {
          promptTokens,
          completionTokens,
          totalTokens,
          maxTokens,
          iteration: this.stats.iterations,
        }
        // 记录最近一轮 token 用量，用于 onDone 时返回
        this.latestTokenUsage = tokenUsage

        // ── 检查是否遭遇截断 (Out of Token) ──
        if (result.finishReason === 'length') {
          log.warn(`[Agent] sessionId=${this.sessionId} 遭遇 Token 截断，自动插入续写提示`)
          this.history.push({
            id: genMsgId('user'),
            role: 'user',
            content: `[System Reminder: Output token limit hit. Please resume your response directly from where you were cut off. Do not apologize, do not summarize, just pick up mid-thought and continue.]`,
            createdAt: Date.now(),
          })
        }

        const llmSpanId = `span_llm_${Math.random().toString(36).slice(2, 9)}`
        collector.record('llm.call', {
          llmCallId: `llm_call_${Math.random().toString(36).slice(2, 9)}`,
          contextSnapshotId,
          model: getConfig().llm_model,
          temperature: 0.3,
          maxOutputTokens: 4096,
          promptTokens: result.usage?.prompt_tokens ?? 0,
          completionTokens: result.usage?.completion_tokens ?? 0,
          totalTokens: result.usage?.total_tokens ?? 0,
          latencyMs,
          usage: result.usage,
          prompt_tokens_details: result.usage?.prompt_tokens_details,
          completion_tokens_details: (result.usage as any)?.completion_tokens_details,
          prompt_cache_hit_tokens: (result.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0,
          prompt_cache_miss_tokens: (result.usage?.prompt_tokens ?? 0) - ((result.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0),
          reasoning_tokens: (result.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0,
          input: {
            messages: apiMessages,
            tools: tools
          },
          output: {
            type: result.toolCalls.length ? 'tool_call' : 'text',
            content: result.content,
            toolCalls: result.toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments
            }))
          }
        }, { spanId: llmSpanId, parentSpanId: contextSpanId })

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
          // 把本轮 LLM 的 token 使用量随工具开始事件推给前端，便于实时刷新「上下文占比」UI
          tokenUsage,
        })

        const toolResults = await this.executeAllTools(
          result.toolCalls,
          opts.callbacks,
          collector,
          llmSpanId,
          this.abortController?.signal
        )
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
        // 把最近一轮（即最后一次 LLM 调用）的 token 使用量发给前端，作为 Context 显示来源
        tokenUsage: this.latestTokenUsage ?? undefined,
        aborted: wasAborted,
        abortReason: wasAborted ? (timedOut ? 'timeout' : 'user') : undefined,
      })

      if (!wasAborted) {
        executionStatus = 'success'
      }
    } catch (e: unknown) {
      // 用户主动中断：当作"已完成"处理（保留已经产生的部分）
      if (isAbortError(e) || (this.abortController && this.abortController.signal.aborted)) {
        this.stats.totalDurationMs = Date.now() - overallStart
        this.persistSession(finalContent || '(用户中断)')
        opts.callbacks.onDone({
          sessionId: this.sessionId,
          content: finalContent || '(用户中断)',
          iterations: this.stats.iterations,
          stats: { ...this.stats },
          tokenUsage: this.latestTokenUsage ?? undefined,
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

      collector.record('turn.end', {
        status: executionStatus,
        assistantMessage: finalContent
      })
      collector.record('run.end', {
        status: executionStatus,
        latencyMs: Date.now() - overallStart,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens
      })

      const jsonlData = collector.toJSONL()
      fetch('http://127.0.0.1:4310/api/runs/import-jsonl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: jsonlData })
      })
        .then(async (res) => {
          if (res.ok) {
            log.info(`[Jarvis Bridge] Trace 同步成功 runId=${curRunId}`)
          } else {
            log.warn(`[Jarvis Bridge] Trace 同步返回非200状态: ${res.status}`)
          }
        })
        .catch(err => {
          log.error('[Jarvis Bridge] Trace 自动推送失败:', err)
        })
    }
  }

  /**
   * 执行一组工具调用
   *
   * 调度策略（参考 Claude Code 的并发安全分组）：
   *  - 把工具切成连续块，每块要么全部"并发安全"要么含至少一个"不安全"
   *  - 并发安全块：用 Promise.all 并行执行（如多个 read_file / grep_code）
   *  - 不安全块：顺序执行（如 write_file / run_command）
   *  - 这样能在多读场景下显著加速，同时保证写竞争安全
   *
   * 每一步都通过 IPC 推送，让 UI 实时看到进度
   */
  private async executeAllTools(
    toolCalls: AgentToolCall[],
    cb: AgentCallbacks,
    collector: MemoryTraceCollector,
    llmSpanId: string,
    signal?: AbortSignal,
  ): Promise<AgentToolResult[]> {
    // 保留原始顺序的结果索引：toolCalls[i] 对应 results[i]
    const results: AgentToolResult[] = new Array(toolCalls.length)

    // 切分成连续的"安全块/不安全块"
    const buckets: Array<{ safe: boolean; calls: Array<{ tc: AgentToolCall; idx: number }> }> = []
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      const safe = isConcurrencySafe(tc.name)
      const last = buckets[buckets.length - 1]
      if (last && last.safe === safe) {
        last.calls.push({ tc, idx: i })
      } else {
        buckets.push({ safe, calls: [{ tc, idx: i }] })
      }
    }

    for (const bucket of buckets) {
      if (bucket.safe && bucket.calls.length > 1) {
        log.info(`[Agent] 并行执行 ${bucket.calls.length} 个只读工具: ${bucket.calls.map(c => c.tc.name).join(', ')}`)
        const promises = bucket.calls.map(({ tc, idx }) =>
          this.runOneTool(tc, cb, collector, llmSpanId, signal).then(r => {
            results[idx] = r
            return r
          })
        )
        await Promise.all(promises)
      } else {
        // 不安全块或只有一个工具 → 顺序
        for (const { tc, idx } of bucket.calls) {
          results[idx] = await this.runOneTool(tc, cb, collector, llmSpanId, signal)
          // 不安全工具有致命错误时早退（与原串行行为一致）
          if (results[idx].fatal) break
        }
      }
    }
    return results
  }

  /** 执行单个工具调用并维护 trace + 回调 */
  private async runOneTool(
    tc: AgentToolCall,
    cb: AgentCallbacks,
    collector: MemoryTraceCollector,
    llmSpanId: string,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    cb.onToolExecuting({
      sessionId: this.sessionId,
      toolId: tc.id,
      toolName: tc.name,
    })

    const toolSpanId = `span_tool_${tc.id}`

    collector.record('tool.policy.check', {
      decision_id: `perm_${tc.id}`,
      tool_call_id: tc.id,
      tool_id: tc.name,
      riskLevel: tc.name === 'run_command' ? 'high' : 'low',
      requestedPermissions: [],
      decision: 'allow',
      status: 'allow',
      reason: '用户在小牛马客户端人工确认批准',
      input: {
        tool: tc.name,
        arguments: tc.arguments
      }
    }, { spanId: `span_perm_${tc.id}`, parentSpanId: llmSpanId })

    collector.record('tool.call', {
      toolCallId: tc.id,
      tool: tc.name,
      arguments: tc.arguments,
      input: tc.arguments,
      permission: {
        required: [],
        approved: true,
        approvalMode: 'manual'
      }
    }, { spanId: toolSpanId, parentSpanId: llmSpanId })

    // 把当前会话的项目工作目录注入工具上下文，作为相对路径解析基准
    const result = await executeTool(tc, { signal, projectCwd: this.projectCwd })

    collector.record('tool.call', {
      toolCallId: tc.id,
      tool: tc.name,
      arguments: tc.arguments,
      input: tc.arguments,
      permission: {
        required: [],
        approved: true,
        approvalMode: 'manual'
      },
      execution: {
        success: !result.error,
        exitCode: result.error ? 1 : 0,
        latencyMs: result.durationMs ?? 0
      },
      result: result.error ? `错误: ${result.error}` : result.output
    }, { spanId: toolSpanId, parentSpanId: llmSpanId })

    cb.onToolExecuted({
      sessionId: this.sessionId,
      toolId: tc.id,
      toolName: tc.name,
      success: !result.error,
      output: result.output,
      error: result.error,
      durationMs: result.durationMs,
    })

    return result
  }

  /**
   * 把当前 history 写入会话存储
   * 标题由首条 user 消息生成；projectId 用于多项目过滤
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
        // 记录会话所属项目，便于按项目过滤
        projectId: this.projectId,
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

  // user 角色：如果有附件，拼接附件内容到 content，再追加环境与技能快照
  if (m.role === 'user') {
    let content = m.content
    if (m.attachments && m.attachments.length > 0) {
      content = buildContentWithAttachments(m.content, m.attachments)
    }
    if ((m as any).dynamicContext) {
      content = content + '\n' + (m as any).dynamicContext
    }
    if ((m as any).skillAdditionText) {
      content = content + '\n' + (m as any).skillAdditionText
    }
    return { role: m.role, content }
  }

  // 兜底：assistant 无 tool_calls、或其他未预期的角色
  return { role: m.role as any, content: m.content || '' }
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

/**
 * 工具是否可与同批其他工具并发执行
 *
 * 安全清单：只读、无外部副作用的工具可并发；
 * 黑名单：写文件 / 改数据 / 改技能 / 调度任务 / 执行命令 / 系统操作 都不能并发。
 *
 * 为什么用白名单：宁可漏掉某个本可并发的新工具（性能略低）也不能误把写工具放进并发桶。
 */
function isConcurrencySafe(toolName: string): boolean {
  const CONCURRENT_SAFE_TOOLS: ReadonlySet<string> = new Set([
    // 文件读类
    'read_file', 'list_files', 'search_files',
    // 代码搜索
    'grep_code', 'glob_files',
    // Git 只读
    'git_status', 'git_diff', 'git_log',
    // 网络只读
    'web_fetch', 'web_search',
    // 小牛马数据读类
    'get_today_log', 'get_todos', 'get_logs_range',
    // 调度器/技能查询
    'scheduler_list_tasks', 'skill_list', 'skill_get',
  ])
  return CONCURRENT_SAFE_TOOLS.has(toolName)
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

/**
 * 推断当前模型的上下文窗口上限（用于前端显示占比）
 * 与 context-compressor.ts 的模型识别策略保持一致
 */
export function inferModelMaxTokens(): number {
  const cfg = getConfig()
  const model = (cfg.agent_llm_model || cfg.llm_model || '').toLowerCase()
  if (!model) return 32_768
  if (model.includes('gpt-4o') || model.includes('gpt-4-turbo')) return 128_000
  if (model.includes('gpt-5') || model.includes('o1') || model.includes('o3')) return 128_000
  if (model.includes('claude-3') || model.includes('claude-4')) return 200_000
  if (model.includes('claude')) return 200_000
  if (model.includes('gemini')) return 128_000
  if (model.includes('deepseek')) return 64_000
  if (model.includes('qwen')) return 32_768
  if (model.includes('moonshot') || model.includes('kimi')) return 128_000
  if (model.includes('minimax')) return 245_760
  return 32_768
}
