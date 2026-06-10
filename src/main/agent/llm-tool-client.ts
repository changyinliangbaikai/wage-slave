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
  // 优先使用 Agent 专用配置，未配置则回退到主聊天配置
  const baseUrl = (config.agent_llm_api_url || config.llm_api_url).replace(/\/$/, '')
  const model = config.agent_llm_model || config.llm_model

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
    model,
    messages: params.messages,
    tools: params.tools,
    tool_choice: 'auto',
    temperature: params.temperature ?? 0.3,
    max_tokens: params.maxTokens ?? 4096,
    stream: true,
  }

  log.info(`[AgentLLM] 发起请求 model=${model} messages=${params.messages.length} tools=${params.tools.length}`)

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
    if (params.tools.length > 0 && isToolUnsupportedError(res.status, errText)) {
      log.warn(`[AgentLLM] 当前模型/API 不支持 tool_calls，切换 ReAct 文本协议: HTTP ${res.status}`)
      return await streamLLMReactFallback(params, errText)
    }
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
          // 只在累积新的 tool_calls 时记录 debug 日志（避免刷屏）
          const beforeCount = toolBuffer.size
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            const buf = toolBuffer.get(idx) ?? { id: '', name: '', arguments: '' }
            if (tc.id) buf.id = tc.id
            if (tc.function?.name) buf.name = tc.function.name
            if (tc.function?.arguments) buf.arguments += tc.function.arguments
            toolBuffer.set(idx, buf)
          }
          const afterCount = toolBuffer.size
          if (afterCount > beforeCount) {
            log.debug(`[AgentLLM] 新增 tool_calls: ${afterCount - beforeCount} 个 (总计 ${afterCount})`)
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

/**
 * ReAct 文本协议降级：
 * 某些 OpenAI 兼容接口会拒绝 tools/tool_choice 参数。此时不让 Agent 整体失败，
 * 而是重试一次普通对话，并要求模型用 <tool_call>{...}</tool_call> 标签表达工具调用。
 */
async function streamLLMReactFallback(params: StreamLLMParams, originalError: string): Promise<StreamResult> {
  const config = getConfig()
  const baseUrl = (config.agent_llm_api_url || config.llm_api_url).replace(/\/$/, '')
  const model = config.agent_llm_model || config.llm_model
  const splitter = new ThinkSplitter()
  let fullContent = ''
  let fullReasoning = ''
  let finishReason: string | null = null

  const fallbackMessages = injectFallbackProtocol(params.messages, params.tools, originalError)
  const body = {
    model,
    messages: fallbackMessages,
    temperature: params.temperature ?? 0.3,
    max_tokens: params.maxTokens ?? 4096,
    stream: true,
  }

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
    throw new Error(`LLM API 降级请求仍失败 ${res.status}: ${errText.slice(0, 200)}`)
  }
  if (!res.body) {
    throw new Error('LLM 降级响应 body 为空')
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

        const reasoningDelta = (delta.reasoning_content ?? delta.reasoning ?? '') as string
        if (reasoningDelta) fullReasoning += reasoningDelta

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const parts = splitter.push(delta.content)
          if (parts.reasoning) fullReasoning += parts.reasoning
          if (parts.content) fullContent += parts.content
        }

        if ((reasoningDelta || (delta.content && delta.content.length > 0)) && params.onDelta) {
          params.onDelta({ content: stripFallbackToolTags(fullContent), reasoning: fullReasoning })
        }

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
      return { content: stripFallbackToolTags(fullContent), reasoning: fullReasoning, toolCalls: [], finishReason, aborted: true }
    }
    throw e
  }

  const tail = splitter.flush()
  if (tail.reasoning) fullReasoning += tail.reasoning
  if (tail.content) fullContent += tail.content

  log.info(`[AgentLLM] ReAct 原始响应内容（前500字）: ${fullContent.slice(0, 500)}`)
  const parsed = parseFallbackToolCalls(fullContent)
  log.info(`[AgentLLM] ReAct 降级完成 finish=${finishReason ?? 'null'} content=${parsed.content.length}字 toolCalls=${parsed.toolCalls.length}`)
  return {
    content: parsed.content,
    reasoning: fullReasoning,
    toolCalls: parsed.toolCalls,
    finishReason,
    aborted: false,
  }
}

function injectFallbackProtocol(
  messages: StreamLLMParams['messages'],
  tools: ToolSchema[],
  originalError: string,
): StreamLLMParams['messages'] {
  const toolList = tools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }))
  const protocol = `\n\n# 工具调用降级协议\n\n当前模型或 API 不支持 OpenAI tool_calls（原始错误：${originalError.slice(0, 160)}）。\n如果需要调用工具，请使用以下格式之一：\n\n格式1 - XML标签（推荐）：\n<tool_call>{"name":"工具名","arguments":{"参数名":"值"}}</tool_call>\n\n格式2 - Markdown代码块：\n\`\`\`json\n{"name":"工具名","arguments":{"参数名":"值"}}\n\`\`\`\n\n规则：\n- name 必须来自下方工具列表\n- arguments 必须是 JSON 对象\n- 需要工具时不要编造最终结果，先输出工具调用等待执行结果\n- 不需要工具时正常回复，不要输出工具调用格式\n- 如果需要调用多个工具，请依次输出多个标签\n\n示例（读取文件）：\n<tool_call>{"name":"read_file","arguments":{"path":"/Users/jhx/Desktop/test.txt"}}</tool_call>\n\n可用工具：\n${JSON.stringify(toolList, null, 2)}`

  const normalizedMessages = normalizeMessagesForReactFallback(messages)
  const [first, ...rest] = normalizedMessages
  if (first?.role === 'system') {
    return [{ ...first, content: first.content + protocol }, ...rest]
  }
  return [{ role: 'system', content: protocol }, ...normalizedMessages]
}

function normalizeMessagesForReactFallback(messages: StreamLLMParams['messages']): StreamLLMParams['messages'] {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [
          `工具结果（${m.name ?? m.tool_call_id ?? 'unknown'}）：`,
          m.content,
        ].join('\n'),
      }
    }

    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls
        .map(tc => `${tc.function.name}(${tc.function.arguments || '{}'})`)
        .join('\n')
      return {
        role: 'assistant',
        content: [
          m.content,
          `[已请求工具]\n${calls}`,
        ].filter(Boolean).join('\n\n'),
      }
    }

    return {
      role: m.role,
      content: m.content,
    }
  })
}

function parseFallbackToolCalls(rawContent: string): { content: string; toolCalls: AgentToolCall[] } {
  const toolCalls: AgentToolCall[] = []
  let idx = 0
  let cleanedContent = rawContent

  // 1) 解析 <tool_call> 标签格式
  const tagPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(rawContent)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as { name?: unknown; arguments?: unknown }
      const tc = extractToolCall(parsed, `react_tag_${Date.now()}_${idx++}`)
      if (tc) toolCalls.push(tc)
    } catch (e) {
      log.warn('[AgentLLM] ReAct <tool_call> 标签解析失败:', e)
    }
  }
  cleanedContent = cleanedContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')

  // 2) 解析 Markdown 代码块中的 JSON（支持 ```json 和 ``` 两种）
  const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)```/gi
  while ((match = codeBlockPattern.exec(rawContent)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown
      // 可能是单个工具调用或数组
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const tc = extractToolCall(item as Record<string, unknown>, `react_block_${Date.now()}_${idx++}`)
          if (tc) toolCalls.push(tc)
        }
      } else if (typeof parsed === 'object' && parsed !== null) {
        const tc = extractToolCall(parsed as Record<string, unknown>, `react_block_${Date.now()}_${idx++}`)
        if (tc) toolCalls.push(tc)
      }
    } catch (e) {
      // 静默忽略非 JSON 代码块
    }
  }
  cleanedContent = cleanedContent.replace(/```(?:json)?\s*\n?[\s\S]*?```/gi, '')

  log.info(`[AgentLLM] ReAct 解析完成: 找到 ${toolCalls.length} 个工具调用`)
  return {
    content: cleanedContent.trim(),
    toolCalls,
  }
}

/**
 * 从解析的对象中提取工具调用信息，支持多种字段命名
 */
function extractToolCall(parsed: Record<string, unknown>, id: string): AgentToolCall | null {
  // 支持多种字段名: name/function/tool, arguments/args/parameters/params
  const name = (parsed.name ?? parsed.function ?? parsed.tool) as string | undefined
  if (typeof name !== 'string' || !name.trim()) return null

  let args: Record<string, unknown> = {}
  const rawArgs = parsed.arguments ?? parsed.args ?? parsed.parameters ?? parsed.params
  if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>
  }

  return { id, name: name.trim(), arguments: args }
}

function stripFallbackToolTags(content: string): string {
  // 同时移除 <tool_call> 标签和代码块
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/```(?:json)?\s*\n?[\s\S]*?```/gi, '')
    .trim()
}

function isToolUnsupportedError(status: number, text: string): boolean {
  if (status < 400 || status >= 500) return false
  const lower = text.toLowerCase()
  const mentionsToolParam =
    lower.includes('tool') ||
    lower.includes('function_call') ||
    lower.includes('function calling') ||
    lower.includes('functions')
  const looksUnsupported =
    lower.includes('not support') ||
    lower.includes('unsupported') ||
    lower.includes('unknown parameter') ||
    lower.includes('unrecognized') ||
    lower.includes('extra fields') ||
    lower.includes('invalid parameter') ||
    lower.includes('tool_choice')
  return mentionsToolParam && looksUnsupported
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
