/**
 * Agent 专用的流式 LLM 客户端
 *
 * 与 ai-chat-service 的差异：
 *  - 增量解析 OpenAI function calling 的 tool_calls 数组
 *  - 一次响应可能既包含文本（reasoning + content），也包含 tool_calls
 *  - 不做 token 统计（Agent 的统计在 Orchestrator 层做）
 *
 * 复用思想：
 *  - <think>...</think> 切分逻辑参考 ai-chat-service 的 ThinkSplitter
 *  - SSE / fetch / Bearer 头部与现有项目一致
 */

import log from 'electron-log/main'
import { getConfig } from '../store'
import type { AgentToolCall } from '@shared/types'
import type { ToolSchema } from './tool-registry'

/** 流式调用结果 */
export interface StreamResult {
  /** 累计正式回复（已剥离 think 块） */
  content: string
  /** 累计推理内容 */
  reasoning: string
  /** 本轮的工具调用列表（按 LLM 返回顺序） */
  toolCalls: AgentToolCall[]
  /** finish_reason（OpenAI 兼容）：'stop' / 'tool_calls' / 'length' / null */
  finishReason: string | null
  /** 是否是用户主动 abort */
  aborted: boolean
}

export interface StreamLLMParams {
  /** 完整消息列表（含 system + history + 本轮 user/tool 消息） */
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    tool_call_id?: string
    name?: string
  }>
  /** 工具 schema 列表（OpenAI function calling 格式） */
  tools: ToolSchema[]
  /** API Key（从 keytar 读出后传入） */
  apiKey: string
  /** 用户主动中断信号 */
  signal: AbortSignal
  /** 最大 token 数，默认 4096 */
  maxTokens?: number
  /** 温度，默认 0.3（Agent 场景需要相对确定性） */
  temperature?: number
  /** 流式增量回调（每收到一个 chunk 就触发） */
  onDelta?: (delta: { content: string; reasoning: string }) => void
}

/**
 * Think 块切分器（参考 ai-chat-service 的 ThinkSplitter）
 * 把 LLM 输出中的 <think>...</think> 拆到 reasoning 通道
 */
class ThinkSplitter {
  private inThink = false
  private buffer = ''

  push(delta: string): { reasoning: string; content: string } {
    let reasoning = ''
    let content = ''
    this.buffer += delta

    while (this.buffer.length > 0) {
      if (this.inThink) {
        const end = this.buffer.indexOf('</think>')
        if (end === -1) {
          // 防止 </think 标签被截断在 buffer 末尾，保留最后 8 字符
          const safeLen = Math.max(0, this.buffer.length - 8)
          reasoning += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
        reasoning += this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + '</think>'.length)
        this.inThink = false
      } else {
        const start = this.buffer.indexOf('<think>')
        if (start === -1) {
          const safeLen = Math.max(0, this.buffer.length - 7)
          content += this.buffer.slice(0, safeLen)
          this.buffer = this.buffer.slice(safeLen)
          break
        }
        content += this.buffer.slice(0, start)
        this.buffer = this.buffer.slice(start + '<think>'.length)
        this.inThink = true
      }
    }

    return { reasoning, content }
  }

  flush(): { reasoning: string; content: string } {
    if (this.buffer.length === 0) return { reasoning: '', content: '' }
    const rest = this.buffer
    this.buffer = ''
    return this.inThink ? { reasoning: rest, content: '' } : { reasoning: '', content: rest }
  }
}

/**
 * 发起一次流式 LLM 调用
 *
 * 关键 SSE 字段：
 *  - delta.content：正式回复增量
 *  - delta.reasoning_content / delta.reasoning：DeepSeek/Qwen/MiniMax 推理通道
 *  - delta.tool_calls：OpenAI function calling 增量（按 index 累积）
 *  - choices[0].finish_reason：'stop' | 'tool_calls' | 'length'
 */
export async function streamLLMWithTools(params: StreamLLMParams): Promise<StreamResult> {
  const config = getConfig()
  const baseUrl = config.llm_api_url.replace(/\/$/, '')

  if (!params.apiKey) {
    throw new Error('未配置 API Key，请先在「设置」中填写')
  }

  const splitter = new ThinkSplitter()
  let fullContent = ''
  let fullReasoning = ''
  let finishReason: string | null = null
  // 工具调用按 index 增量累积（OpenAI 协议）
  const toolBuffer = new Map<number, { id: string; name: string; arguments: string }>()

  const body = {
    model: config.llm_model,
    messages: params.messages,
    tools: params.tools,
    tool_choice: 'auto',
    temperature: params.temperature ?? 0.3,
    max_tokens: params.maxTokens ?? 4096,
    stream: true,
  }

  log.info(`[AgentLLM] 发起请求 model=${config.llm_model} messages=${params.messages.length} tools=${params.tools.length}`)

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    })
  } catch (e: unknown) {
    if (isAbortError(e)) {
      return { content: fullContent, reasoning: fullReasoning, toolCalls: [], finishReason, aborted: true }
    }
    throw e
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`LLM API 返回 ${res.status}: ${errText.slice(0, 200)}`)
  }
  if (!res.body) {
    throw new Error('LLM 响应 body 为空')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let sseBuffer = ''

  try {
    outer: while (true) {
      const { done, value } = await reader.read()
      if (done) break

      sseBuffer += decoder.decode(value, { stream: true })
      const lines = sseBuffer.split('\n')
      sseBuffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') break outer

        let chunk: SSEChunk
        try {
          chunk = JSON.parse(data) as SSEChunk
        } catch {
          continue
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta ?? {}

        // 1) reasoning_content（DeepSeek/Qwen/MiniMax）
        const reasoningDelta = (delta.reasoning_content ?? delta.reasoning ?? '') as string
        if (reasoningDelta) {
          fullReasoning += reasoningDelta
        }

        // 2) content（含可能的 <think> 嵌入）
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const parts = splitter.push(delta.content)
          if (parts.reasoning) fullReasoning += parts.reasoning
          if (parts.content) fullContent += parts.content
        }

        // 3) tool_calls（按 index 增量累积）
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const buf = toolBuffer.get(idx) ?? { id: '', name: '', arguments: '' }
            if (tc.id) buf.id = tc.id
            if (tc.function?.name) buf.name = tc.function.name
            if (tc.function?.arguments) buf.arguments += tc.function.arguments
            toolBuffer.set(idx, buf)
          }
        }

        // 增量回调（content / reasoning 有任一更新就推）
        if ((reasoningDelta || (delta.content && delta.content.length > 0)) && params.onDelta) {
          params.onDelta({ content: fullContent, reasoning: fullReasoning })
        }

        // finish_reason 通常出现在最后一个 chunk
        if (choice.finish_reason) {
          finishReason = choice.finish_reason
        }
      }
    }
  } catch (e: unknown) {
    if (isAbortError(e)) {
      const tail = splitter.flush()
      if (tail.reasoning) fullReasoning += tail.reasoning
      if (tail.content) fullContent += tail.content
      return { content: fullContent, reasoning: fullReasoning, toolCalls: [], finishReason, aborted: true }
    }
    throw e
  }

  // 收尾：flush 残留 buffer
  const tail = splitter.flush()
  if (tail.reasoning) fullReasoning += tail.reasoning
  if (tail.content) fullContent += tail.content

  // 把 toolBuffer 转成有序的 toolCalls 数组（按 index 升序）
  const toolCalls: AgentToolCall[] = []
  const sorted = [...toolBuffer.entries()].sort((a, b) => a[0] - b[0])
  for (const [, buf] of sorted) {
    if (!buf.id || !buf.name) continue
    let parsed: Record<string, unknown> = {}
    if (buf.arguments) {
      try {
        parsed = JSON.parse(buf.arguments) as Record<string, unknown>
      } catch (e) {
        log.warn(`[AgentLLM] 工具参数 JSON 解析失败 name=${buf.name} args=${buf.arguments.slice(0, 120)}`)
        // 解析失败也保留，让上层把错误反馈给 LLM 重试
        parsed = { __parse_error: String(e), __raw: buf.arguments }
      }
    }
    toolCalls.push({ id: buf.id, name: buf.name, arguments: parsed })
  }

  log.info(`[AgentLLM] 完成 finish=${finishReason ?? 'null'} content=${fullContent.length}字 toolCalls=${toolCalls.length}`)

  return {
    content: fullContent,
    reasoning: fullReasoning,
    toolCalls,
    finishReason,
    aborted: false,
  }
}

/** SSE chunk 的 OpenAI 兼容结构 */
interface SSEChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      reasoning?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
}

function isAbortError(e: unknown): boolean {
  return Boolean(e) && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}
